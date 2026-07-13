import {
	type ClassifiedWebhookError,
	captureContextException,
	classifyWebhookError,
} from "./sentry";
import {
	appendActivityLog,
	JOB_HISTORY_MAX,
	jobHistoryStorage,
	sanitizeSettings,
	seenJobIdsStorage,
	settingsStorage,
	webhookErrorsStorage,
	webhookFailureCountsStorage,
} from "./storage";
import type {
	Job,
	LegacyWebhookJob,
	ScrapeResult,
	SearchTarget,
	WebhookJob,
} from "./types";

const ALARM_NAME = "upwork-scrape";
const JITTER_SECONDS = 30;
const MIN_ALARM_DELAY_MINUTES = 0.5;

function getPostedSourceRank(source: string): number {
	if (source === "upwork_absolute") return 3;
	if (source === "relative_estimate") return 2;
	if (source === "fallback_scraped_at") return 1;
	return 0;
}

function toWebhookJob(job: Job): WebhookJob {
	return {
		...job,
		postedAtIso: new Date(job.postedAtMs).toISOString(),
	};
}

function toLegacyWebhookJob(job: Job, target: SearchTarget): LegacyWebhookJob {
	const scrapedAtMs = Date.parse(job.scrapedAt);
	const safeScrapedAt = Number.isFinite(scrapedAtMs)
		? scrapedAtMs
		: job.postedAtMs;

	return {
		title: job.title,
		url: job.url,
		jobType: job.jobType,
		skillLevel: job.experienceLevel,
		budget: job.budget,
		hourlyRange: "N/A",
		estimatedTime: "N/A",
		description: job.description,
		skills: job.skills,
		paymentVerified: job.paymentVerified,
		clientRating: job.clientRating,
		clientSpent: job.clientTotalSpent,
		clientCountry: "N/A",
		questions: [],
		scrapedAt: safeScrapedAt,
		scrapedAtHuman: new Date(safeScrapedAt).toLocaleString(),
		clientLocation: "N/A",
		sourceUrl: target.searchUrl,
		source: {
			name: target.name,
			searchUrl: target.searchUrl,
			webhookUrl: target.webhookUrl,
		},
	};
}

function shouldUseLegacyPayload(target: SearchTarget): boolean {
	return (
		target.payloadMode === "legacy-v1" && target.legacyCompatibilityEligible
	);
}

function getJitteredDelayMinutes(baseMinutes: number): number {
	const jitterSeconds = Math.random() * (JITTER_SECONDS * 2) - JITTER_SECONDS;
	const jitterMinutes = jitterSeconds / 60;
	return Math.max(MIN_ALARM_DELAY_MINUTES, baseMinutes + jitterMinutes);
}

export async function setupAlarm(): Promise<void> {
	const settings = sanitizeSettings(await settingsStorage.getValue());
	await browser.alarms.clear(ALARM_NAME);

	if (!settings.masterEnabled) return;

	const baseDelayMinutes = Math.max(
		5,
		Math.floor(settings.minuteInterval || 5),
	);
	const delayInMinutes = getJitteredDelayMinutes(baseDelayMinutes);

	browser.alarms.create(ALARM_NAME, { delayInMinutes });
}

function parseTimeToMinutes(value: string): number | null {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match) return null;

	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

	return hour * 60 + minute;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function isNoCurrentWindowError(error: unknown): boolean {
	return /No current window/i.test(toErrorMessage(error));
}

function isFrameRemovedError(error: unknown): boolean {
	return /Frame with ID \d+ was removed\.?/i.test(toErrorMessage(error));
}

function isNoTabError(error: unknown): boolean {
	return /No tab with id:?\s*\d+/i.test(toErrorMessage(error));
}

async function resolveWindowIdForBackgroundTab(): Promise<number | undefined> {
	try {
		const lastFocused = await browser.windows.getLastFocused({
			windowTypes: ["normal"],
		});
		if (typeof lastFocused.id === "number") return lastFocused.id;
	} catch {
		// Fall through to a tabs-based normal window lookup.
	}

	try {
		const [activeTab] = await browser.tabs.query({
			active: true,
			windowType: "normal",
		});
		return typeof activeTab?.windowId === "number"
			? activeTab.windowId
			: undefined;
	} catch {
		// Window targeting is optional; let tabs.create choose the window.
		return undefined;
	}
}

function isChromeErrorUrl(url: string | undefined): boolean {
	return typeof url === "string" && url.startsWith("chrome-error://");
}

function hasExpectedOrigin(
	url: string | undefined,
	expectedOrigin: string,
): boolean {
	if (typeof url !== "string" || url === "") return false;
	try {
		return new URL(url).origin === expectedOrigin;
	} catch {
		return false;
	}
}

async function waitForTabComplete(
	tabId: number,
	expectedOrigin: string,
): Promise<void> {
	const currentTab = await browser.tabs.get(tabId).catch(() => null);
	if (currentTab?.status === "complete") {
		if (isChromeErrorUrl(currentTab.url)) {
			throw new Error("Chrome error page");
		}
		if (hasExpectedOrigin(currentTab.url, expectedOrigin)) {
			return;
		}
	}

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Tab load timeout"));
		}, 60_000);

		const cleanup = () => {
			clearTimeout(timeout);
			browser.tabs.onUpdated.removeListener(onUpdated);
			browser.tabs.onRemoved.removeListener(onRemoved);
		};

		const onRemoved = (removedTabId: number) => {
			if (removedTabId !== tabId) return;
			cleanup();
			reject(new Error("Tab was removed before loading completed"));
		};

		const onUpdated = (
			updatedTabId: number,
			changeInfo: { status?: string; url?: string },
			updatedTab: { status?: string; url?: string },
		) => {
			if (updatedTabId !== tabId) return;

			if (isChromeErrorUrl(changeInfo.url) || isChromeErrorUrl(updatedTab.url)) {
				cleanup();
				reject(new Error("Chrome error page"));
				return;
			}

			if (updatedTab.status !== "complete") return;

			if (hasExpectedOrigin(updatedTab.url, expectedOrigin)) {
				cleanup();
				resolve();
			}
		};

		browser.tabs.onUpdated.addListener(onUpdated);
		browser.tabs.onRemoved.addListener(onRemoved);
	});
}

async function executeScriptWithFrameRetry<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isFrameRemovedError(error)) {
			throw error;
		}

		await new Promise((resolve) => setTimeout(resolve, 250));
		return operation();
	}
}

function shouldRunNow(
	settings: Awaited<ReturnType<typeof settingsStorage.getValue>>,
): boolean {
	const now = new Date();
	const dayIndex = now.getDay();
	if (!settings.activeDays[dayIndex]) return false;

	const startMinutes = parseTimeToMinutes(settings.timeWindow.start);
	const endMinutes = parseTimeToMinutes(settings.timeWindow.end);
	if (startMinutes === null || endMinutes === null) return false;
	if (startMinutes > endMinutes) return false;

	const nowMinutes = now.getHours() * 60 + now.getMinutes();
	return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

async function scrapeTarget(target: SearchTarget): Promise<ScrapeResult> {
	let tabIdToRemove: number | undefined;

	try {
		const windowId = await resolveWindowIdForBackgroundTab();
		// browser.tabs.create types resolve differently in plain tsc vs WXT's bundler;
		// cast through unknown to extract the id safely in both environments.
		const tab = (await browser.tabs.create({
			url: target.searchUrl,
			active: false,
			...(windowId !== undefined ? { windowId } : {}),
		})) as unknown as { id?: number };

		if (!tab.id) throw new Error("Failed to get tab ID");
		const tabId = tab.id;
		tabIdToRemove = tabId;

		// Match on origin only. Upwork bounces tabs through Cloudflare challenges,
		// login redirects, and other same-origin paths before settling; pathname-strict
		// matching meant we waited the full 60s timeout instead of letting Phase 2
		// detect the captcha/login state. Phase 2 still polls 10s for job cards or
		// Cloudflare markers, so loosening this check is safe.
		const { origin } = new URL(target.searchUrl);

		await waitForTabComplete(tabId, origin);

		// Upwork is a React SPA — job cards are rendered asynchronously after the
		// browser fires status:complete. Use an inline executeScript (MV3 awaits
		// the returned Promise) to poll for up to 10s before running the scraper.
		const pageCheckResult = await executeScriptWithFrameRetry(() =>
			browser.scripting.executeScript({
				target: { tabId },
				func: () =>
					new Promise<{ hasJobCards: boolean; sawCloudflareMarker: boolean }>(
						(resolve) => {
							const deadline = Date.now() + 10_000;
							let sawCloudflareMarker = false;

							const hasCloudflareMarker = (): boolean => {
								const pageText = document.body?.innerText ?? "";
								if (/Cloudflare Ray ID/i.test(pageText)) return true;
								if (
									/cloudflare/i.test(pageText) &&
									/verify you are human|security check/i.test(pageText)
								) {
									return true;
								}
								return false;
							};

							const check = () => {
								sawCloudflareMarker =
									sawCloudflareMarker || hasCloudflareMarker();
								const hasJobCards = Boolean(
									document.querySelector("article[data-ev-job-uid]"),
								);

								if (hasJobCards || Date.now() >= deadline) {
									resolve({ hasJobCards, sawCloudflareMarker });
								} else {
									setTimeout(check, 500);
								}
							};
							check();
						},
					),
			}),
		);

		const pageCheck = pageCheckResult?.[0]?.result as
			| { hasJobCards: boolean; sawCloudflareMarker: boolean }
			| undefined;

		if (pageCheck?.sawCloudflareMarker && !pageCheck.hasJobCards) {
			return {
				ok: false,
				reason: "captcha_required",
				error: "Cloudflare challenge did not auto-complete within 10 seconds",
			};
		}

		const results = await executeScriptWithFrameRetry(() =>
			browser.scripting.executeScript({
				target: { tabId },
				files: ["content-scripts/upwork-scraper.js"],
			}),
		);

		return (
			(results?.[0]?.result as ScrapeResult | undefined) ?? {
				ok: false,
				reason: "error",
			}
		);
	} catch (error) {
		if (isNoCurrentWindowError(error)) {
			return {
				ok: false,
				reason: "error",
				error: "No browser window available for scraping",
			};
		}

		if (/Tab load timeout/i.test(toErrorMessage(error))) {
			return {
				ok: false,
				reason: "error",
				error: "Tab load timeout",
			};
		}

		if (/Tab was removed before loading completed/i.test(toErrorMessage(error))) {
			return {
				ok: false,
				reason: "error",
				error: "Tab removed before load",
			};
		}

		if (/Chrome error page/i.test(toErrorMessage(error))) {
			return {
				ok: false,
				reason: "error",
				error: "Chrome error page (network failure)",
			};
		}

		if (isFrameRemovedError(error)) {
			return {
				ok: false,
				reason: "error",
				error: "Frame was removed before script execution completed",
			};
		}

		if (isNoTabError(error)) {
			return {
				ok: false,
				reason: "error",
				error: "Tab no longer exists",
			};
		}

		throw error;
	} finally {
		if (tabIdToRemove !== undefined) {
			browser.tabs.remove(tabIdToRemove).catch(() => {});
		}
	}
}

const WEBHOOK_FAILURE_NOTIFICATION_THRESHOLD = 3;

export function is4xxStatus(httpStatus: number | undefined): boolean {
	return (
		typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500
	);
}

async function trackWebhookFailure(
	target: SearchTarget,
	webhookError: ClassifiedWebhookError,
): Promise<void> {
	const [counts, errors] = await Promise.all([
		webhookFailureCountsStorage.getValue(),
		webhookErrorsStorage.getValue(),
	]);
	const newCount = (counts[target.id] ?? 0) + 1;
	await Promise.all([
		webhookFailureCountsStorage.setValue({ ...counts, [target.id]: newCount }),
		webhookErrorsStorage.setValue({
			...errors,
			[target.id]: { message: webhookError.message, timestamp: Date.now() },
		}),
	]);
	if (newCount === WEBHOOK_FAILURE_NOTIFICATION_THRESHOLD) {
		browser.notifications.create(`webhook-error|${target.id}`, {
			type: "basic",
			iconUrl: "/icon/128.png",
			title: "Webhook Delivery Error",
			message: `"${target.name}" webhook has failed 3 times in a row. Check your webhook URL in Settings.`,
		});
	}
}

async function clearWebhookFailureState(target: SearchTarget): Promise<void> {
	const [counts, errors] = await Promise.all([
		webhookFailureCountsStorage.getValue(),
		webhookErrorsStorage.getValue(),
	]);
	const { [target.id]: _c, ...restCounts } = counts;
	const { [target.id]: _e, ...restErrors } = errors;
	await Promise.all([
		webhookFailureCountsStorage.setValue(restCounts),
		webhookErrorsStorage.setValue(restErrors),
	]);
}

async function processTargetResult(
	target: SearchTarget,
	result: ScrapeResult,
	notificationsEnabled: boolean,
): Promise<number> {
	if (!result.ok || !result.jobs) {
		await sendIssueWebhookIfNeeded(target, result);

		return 0;
	}

	const preferFreshString = (current: string, fresh: string): string =>
		current.trim() !== "" ? current : fresh;

	const seenIds = await seenJobIdsStorage.getValue();
	const seenSet = new Set(seenIds);
	const newJobs = result.jobs.filter((job) => !seenSet.has(job.uid));

	const existingHistory = await jobHistoryStorage.getValue();
	const latestByUid = new Map(result.jobs.map((job) => [job.uid, job]));
	const backfilledHistory = existingHistory.map((existing) => {
		const fresh = latestByUid.get(existing.uid);
		if (!fresh) return existing;

		const existingSourceRank = getPostedSourceRank(existing.postedAtSource);
		const freshSourceRank = getPostedSourceRank(fresh.postedAtSource);
		const shouldUseFreshPosted =
			freshSourceRank > existingSourceRank ||
			(freshSourceRank === existingSourceRank &&
				fresh.postedAtMs < existing.postedAtMs);

		return {
			...existing,
			title: preferFreshString(existing.title, fresh.title),
			url: preferFreshString(existing.url, fresh.url),
			datePosted: preferFreshString(fresh.datePosted, existing.datePosted),
			postedAtMs: shouldUseFreshPosted ? fresh.postedAtMs : existing.postedAtMs,
			postedAtSource: shouldUseFreshPosted
				? fresh.postedAtSource
				: existing.postedAtSource,
			description: preferFreshString(existing.description, fresh.description),
			jobType: preferFreshString(existing.jobType, fresh.jobType),
			budget: preferFreshString(existing.budget, fresh.budget),
			experienceLevel: preferFreshString(
				existing.experienceLevel,
				fresh.experienceLevel,
			),
			skills: existing.skills.length > 0 ? existing.skills : fresh.skills,
			paymentVerified: existing.paymentVerified || fresh.paymentVerified,
			clientRating: preferFreshString(
				existing.clientRating,
				fresh.clientRating,
			),
			clientTotalSpent: preferFreshString(
				existing.clientTotalSpent,
				fresh.clientTotalSpent,
			),
			proposals: preferFreshString(existing.proposals, fresh.proposals),
		};
	});

	const updatedHistory = [...newJobs, ...backfilledHistory].slice(
		0,
		JOB_HISTORY_MAX,
	);
	const updatedSeenIds = [...seenSet, ...newJobs.map((j) => j.uid)];

	await Promise.all([
		jobHistoryStorage.setValue(updatedHistory),
		seenJobIdsStorage.setValue(updatedSeenIds),
	]);

	if (newJobs.length === 0) return 0;

	if (target.webhookEnabled && target.webhookUrl) {
		const useLegacyPayload = shouldUseLegacyPayload(target);
		const webhookJobs = newJobs.map(toWebhookJob);
		const requestBody = useLegacyPayload
			? JSON.stringify(newJobs.map((job) => toLegacyWebhookJob(job, target)))
			: JSON.stringify({
					status: "success",
					targetName: target.name,
					jobs: webhookJobs,
					timestamp: new Date().toISOString(),
				});

		try {
			const response = await fetch(target.webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: requestBody,
			});

			if (!response.ok) {
				const webhookError = classifyWebhookError({ response });
				if (!is4xxStatus(webhookError.httpStatus)) {
					captureContextException(
						"background",
						new Error(webhookError.message),
						{
							operation: "processTargetResult-webhook",
							stage: "webhook_delivery",
							targetUrl: target.searchUrl,
							webhookErrorKind: webhookError.kind,
							httpStatus: webhookError.httpStatus,
							fingerprint: [
								"webhook-delivery",
								"jobs",
								String(webhookError.kind),
							],
						},
					);
				}
				await trackWebhookFailure(target, webhookError);
				await appendActivityLog(
					"error",
					`Webhook failed (${webhookError.kind}): ${webhookError.message}`,
					target.searchUrl,
				);
				return newJobs.length;
			}
			await clearWebhookFailureState(target);
			await appendActivityLog("info", "Webhook delivered", target.searchUrl);
		} catch (err) {
			const webhookError = classifyWebhookError({ error: err });
			if (webhookError.kind !== "failed_to_fetch") {
				captureContextException("background", err, {
					operation: "processTargetResult-webhook",
					stage: "webhook_delivery",
					targetUrl: target.searchUrl,
					webhookErrorKind: webhookError.kind,
					httpStatus: webhookError.httpStatus,
					normalizedMessage: webhookError.message,
					fingerprint: [
						"webhook-delivery",
						"jobs",
						String(webhookError.kind),
					],
				});
			}
			console.error(
				`[Upwork Scraper] Webhook delivery failed for ${target.searchUrl}:`,
				err,
			);
			await appendActivityLog(
				"error",
				`Webhook failed (${webhookError.kind}): ${webhookError.message}`,
				target.searchUrl,
			);
		}
	}

	if (notificationsEnabled) {
		for (const job of newJobs.slice(0, 3)) {
			if (!job.url) continue;
			browser.notifications.create(`job|${job.url}`, {
				type: "basic",
				iconUrl: "/icon/128.png",
				title: "New Upwork Job",
				message: job.title,
				buttons: [{ title: "Open Extension" }, { title: "View Job" }],
			});
		}
		if (newJobs.length > 3) {
			browser.notifications.create("bulk-jobs", {
				type: "basic",
				iconUrl: "/icon/128.png",
				title: "New Upwork Jobs",
				message: `${newJobs.length} new jobs found — open the extension to view them.`,
				buttons: [{ title: "Open Extension" }],
			});
		}
	}

	return newJobs.length;
}

async function sendIssueWebhookIfNeeded(
	target: SearchTarget,
	result: ScrapeResult,
): Promise<void> {
	if (
		!target.webhookEnabled ||
		!target.webhookUrl ||
		!result.reason ||
		result.reason === "no_results"
	) {
		return;
	}

	const issueMessageByReason: Record<string, string> = {
		captcha_required:
			"Cloudflare verification requires manual interaction before scraping can continue.",
		logged_out: "User appears to be logged out of Upwork.",
		error: result.error ?? "An unknown scrape error occurred.",
	};

	try {
		const response = await fetch(target.webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				status: result.reason,
				type: "issue",
				targetName: target.name,
				reason: result.reason,
				message:
					issueMessageByReason[result.reason] ??
					result.error ??
					"Scrape issue detected.",
				targetUrl: target.searchUrl,
				timestamp: new Date().toISOString(),
			}),
		});

		if (!response.ok) {
			const webhookError = classifyWebhookError({ response });
			if (!is4xxStatus(webhookError.httpStatus)) {
				captureContextException("background", new Error(webhookError.message), {
					operation: "sendIssueWebhookIfNeeded",
					stage: "webhook_delivery",
					targetUrl: target.searchUrl,
					reason: result.reason ?? "unknown",
					webhookErrorKind: webhookError.kind,
					httpStatus: webhookError.httpStatus,
					fingerprint: [
						"webhook-delivery",
						"issue",
						String(webhookError.kind),
					],
				});
			}
			await trackWebhookFailure(target, webhookError);
			await appendActivityLog(
				"error",
				`Issue webhook failed (${webhookError.kind}): ${webhookError.message}`,
				target.searchUrl,
			);
			return;
		}
		await clearWebhookFailureState(target);
		await appendActivityLog(
			"info",
			"Issue webhook delivered",
			target.searchUrl,
		);
	} catch (err) {
		const webhookError = classifyWebhookError({ error: err });
		if (webhookError.kind !== "failed_to_fetch") {
			captureContextException("background", err, {
				operation: "sendIssueWebhookIfNeeded",
				stage: "webhook_delivery",
				targetUrl: target.searchUrl,
				reason: result.reason ?? "unknown",
				webhookErrorKind: webhookError.kind,
				httpStatus: webhookError.httpStatus,
				normalizedMessage: webhookError.message,
				fingerprint: [
					"webhook-delivery",
					"issue",
					String(webhookError.kind),
				],
			});
		}
		console.error(
			`[Upwork Scraper] Issue webhook failed for ${target.searchUrl}:`,
			err,
		);
		await appendActivityLog(
			"error",
			`Issue webhook failed (${webhookError.kind}): ${webhookError.message}`,
			target.searchUrl,
		);
	}
}

function resolveRunStatus(
	anyCaptchaRequired: boolean,
	anyLoggedOut: boolean,
	anyError: boolean,
): "success" | "error" | "logged_out" | "captcha_required" {
	if (anyCaptchaRequired) return "captcha_required";
	if (anyLoggedOut) return "logged_out";
	if (anyError) return "error";
	return "success";
}

function isCaptchaRequiredResult(result: ScrapeResult): boolean {
	return !result.ok && result.reason === "captcha_required";
}

function isLoggedOutResult(result: ScrapeResult): boolean {
	return !result.ok && result.reason === "logged_out";
}

function isErrorResult(result: ScrapeResult): boolean {
	return (
		!result.ok &&
		result.reason !== "captcha_required" &&
		result.reason !== "logged_out"
	);
}

const TARGET_CONCURRENCY = 2;
const TAB_TIMEOUT_RETRY_DELAY_MS = 7_000;

async function scrapeTargetWithRetry(
	target: SearchTarget,
): Promise<ScrapeResult> {
	const first = await scrapeTarget(target);

	const shouldRetry =
		!first.ok &&
		first.reason === "error" &&
		typeof first.error === "string" &&
		(/Tab load timeout/i.test(first.error) ||
			/Tab removed before load/i.test(first.error));

	if (!shouldRetry) return first;

	console.warn(
		`[Upwork Scraper] Transient tab failure (${first.error}) for ${target.searchUrl} — retrying once after ${TAB_TIMEOUT_RETRY_DELAY_MS}ms`,
	);
	await new Promise((r) => setTimeout(r, TAB_TIMEOUT_RETRY_DELAY_MS));
	return scrapeTarget(target);
}

async function runWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;

	const runOne = async (): Promise<void> => {
		while (true) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	};

	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		runOne,
	);
	await Promise.all(workers);
	return results;
}

export async function runScrape(options?: { manual?: boolean }): Promise<void> {
	const settings = sanitizeSettings(await settingsStorage.getValue());

	const activeTargets = settings.searchTargets.filter(
		(t) => t.searchUrl.trim() !== "",
	);

	if (activeTargets.length === 0) {
		console.warn(
			"[Upwork Scraper] Skipping scrape — no search URLs configured.",
		);
		await appendActivityLog("warn", "Skipped — no search URLs configured");
		return;
	}

	if (!options?.manual && !settings.masterEnabled) {
		console.warn(
			"[Upwork Scraper] Skipping scrape — automatic scraping is disabled.",
		);
		await appendActivityLog("warn", "Skipped — automatic scraping is disabled");
		return;
	}

	if (!options?.manual && !shouldRunNow(settings)) {
		console.warn(
			"[Upwork Scraper] Skipping scrape — outside active days/time window.",
		);
		await appendActivityLog(
			"info",
			"Skipped — outside active days/time window",
		);
		return;
	}

	await appendActivityLog(
		"info",
		`Scrape started (${options?.manual ? "manual" : "scheduled"}) — ${activeTargets.length} target${activeTargets.length !== 1 ? "s" : ""}`,
	);

	let anyError = false;
	let anyLoggedOut = false;
	let anyCaptchaRequired = false;

	// Scrape phase: run in parallel (capped). The phase is pure I/O against
	// Upwork tabs; it does NOT touch shared storage (seenJobIdsStorage,
	// jobHistoryStorage, activityLogsStorage), which would otherwise race
	// under read-modify-write semantics with concurrency > 1.
	const scrapeOutcomes = await runWithConcurrency(
		activeTargets,
		TARGET_CONCURRENCY,
		async (target) => {
			try {
				return await scrapeTargetWithRetry(target);
			} catch (err) {
				captureContextException("background", err, {
					operation: "runScrape-target",
					stage: "run_target",
					targetUrl: target.searchUrl,
				});
				console.error(
					`[Upwork Scraper] Scrape error for ${target.searchUrl}:`,
					err,
				);
				return {
					ok: false,
					reason: "error",
					error: String(err),
				} as ScrapeResult;
			}
		},
	);

	// Post-process phase: sequential. processTargetResult and appendActivityLog
	// each perform read-modify-write on shared extension storage, so they must
	// not interleave across targets.
	for (let i = 0; i < activeTargets.length; i++) {
		const target = activeTargets[i];
		const result = scrapeOutcomes[i];

		const newCount = await processTargetResult(
			target,
			result,
			settings.notificationsEnabled,
		);

		if (result.ok && result.jobs) {
			await appendActivityLog(
				"info",
				`Scraped: ${newCount} new job${newCount !== 1 ? "s" : ""} found`,
				target.searchUrl,
			);
		} else if (result.reason === "captcha_required") {
			await appendActivityLog(
				"warn",
				"Cloudflare verification required — complete captcha manually to resume scraping",
				target.searchUrl,
			);
		} else if (result.reason === "logged_out") {
			await appendActivityLog(
				"warn",
				"Logged out — please sign in to Upwork",
				target.searchUrl,
			);
		} else if (result.reason === "no_results") {
			await appendActivityLog("info", "No results found", target.searchUrl);
		} else {
			await appendActivityLog(
				"error",
				`Scrape failed: ${result.error ?? "unknown error"}`,
				target.searchUrl,
			);
		}

		if (isCaptchaRequiredResult(result)) anyCaptchaRequired = true;
		else if (isLoggedOutResult(result)) anyLoggedOut = true;
		else if (isErrorResult(result)) anyError = true;
	}

	if (settings.notificationsEnabled && anyCaptchaRequired) {
		browser.notifications.create({
			type: "basic",
			iconUrl: "/icon/128.png",
			title: "Upwork Scraper needs action",
			message:
				"Cloudflare verification is blocking scraping. Open Upwork and complete the captcha check.",
		});
	}

	await settingsStorage.setValue({
		...settings,
		lastRunAt: new Date().toISOString(),
		lastRunStatus: resolveRunStatus(anyCaptchaRequired, anyLoggedOut, anyError),
	});
}
