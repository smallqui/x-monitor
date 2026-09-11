import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "lastStatus.json");

// .env
const { TWITTER_USERNAME, DISCORD_WEBHOOK_URL, TWITTER_AUTH_TOKEN, TWITTER_CT0 } = process.env;
const NOTIFY_ON_STARTUP = parseBooleanEnv("NOTIFY_ON_STARTUP", false);

// webhook constants
const webhookName = "X Monitor";
const webhookIcon = "https://pbs.twimg.com/profile_images/1955359038532653056/OSHY3ewP_400x400.jpg";


// delays
const monitorDelay = Number(process.env.MONITOR_DELAY || 30000);
const navTimeoutMs = 30000;
const statusWaitTimeoutMs = 30000;
const cardSettleMs = 500;
const fetchTimeoutMs = 20000;
const discordMaxRetries = 3;
const pollJitterMs = 3000; // add a short randomized delay between requests to reduce repeated hits and help avoid rate limits
const pageRecycleEvery = 200; // recreate the page periodically to avoid long session memory growth

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"; // user agent for requests and chromium

// flags
let shutdownRequested = false;
let wakeSleep = null;


/**
 * Formats the current time as MM/DD/YYYY hh:mm:ss on a 12-hour clock.
 *
 * @returns {string} The formatted timestamp.
 */
function formatTime(){
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");

	const month = pad(now.getMonth() + 1);
	const day = pad(now.getDate());
	const year = now.getFullYear();

	let hours = now.getHours() % 12;
	if (hours === 0) hours = 12;

	return `${month}/${day}/${year} ${pad(hours)}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
};

/**
 * Prints a single timestamped, tagged log line.
 *
 * @param {string} status - Short tag, e.g. "ERROR", "OK", "SEND".
 * @param {string} message - The message to log.
 */
function log(status, message){
	console.log(`[${formatTime()}] [${status}] ${message}`);
};

/**
 * Reads a boolean flag from `.env`. Anything other than "true"/"false"
 * (case-insensitive) is treated as a misconfiguration rather than being
 * silently coerced — better to see a warning at startup than to wonder
 * later why a setting isn"t behaving as expected.
 *
 * @param {string} name - Environment variable name to read.
 * @param {boolean} fallback - Value to use when the variable is unset.
 * @returns {boolean}
 */
function parseBooleanEnv(name, fallback){
	const raw = process.env[name];
	if (raw === undefined) return fallback;

	const normalized = raw.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;

	log("WARN", `${name} should be "true" or "false", got "${raw}" — using default (${fallback}).`);
	return fallback;
};

/**
 * Validates required .env values before the monitor starts. Exits the
 * process if anything is missing or malformed.
 */
function requireEnv(){
	const missing = ["TWITTER_USERNAME", "DISCORD_WEBHOOK_URL", "TWITTER_AUTH_TOKEN", "TWITTER_CT0"]
		.filter((key) => !process.env[key]);

	if (missing.length){
		log("ERROR", `Missing required .env values: ${missing.join(", ")}`);
		process.exit(1);
	}

	if (!Number.isFinite(monitorDelay) || monitorDelay < 5000){
		log("ERROR", "MONITOR_DELAY must be a number greater than or equal to 5000 (5 seconds, in milliseconds).");
		process.exit(1);
	}

	try {
		const url = new URL(DISCORD_WEBHOOK_URL);
		if (!/^https:$/.test(url.protocol) || !/discord(app)?\.com$/i.test(url.hostname)){
			log("WARN", "DISCORD_WEBHOOK_URL does not look like a standard Discord webhook URL.");
		}
	} 
    catch {
		log("ERROR", "DISCORD_WEBHOOK_URL is not a valid URL.");
		process.exit(1);
	}
};

/**
 * Waits `ms` milliseconds. Resolves early if `wakeSleep()` gets invoked
 * (used to cut the wait short on shutdown).
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
function sleep(ms){
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			wakeSleep = null;
			resolve();
		}, ms);

		wakeSleep = () => {
			clearTimeout(timer);
			wakeSleep = null;
			resolve();
		};
	});
};

/**
 * Truncates `text` to `maxLength` characters, adding an ellipsis if it
 * actually got cut.
 *
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(text, maxLength){
	if (!text || text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
};

/**
 * Swaps X's `_normal` profile image suffix for `_400x400` to pull a bigger avatar than the default thumbnail.
 *
 * @param {string|null} url
 * @returns {string|null}
 */
function upscaleProfileImage(url){
	if (!url) return null;
	return url.replace(/_normal(?=\.[a-z0-9]+(?:\?|$))/i, "_400x400");
};

/**
 * `fetch()` with a hard timeout so a stalled request can't wedge the
 * monitor loop.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = fetchTimeoutMs){
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Loads the last processed status ID from disk, if any.
 *
 * @returns {Promise<string|null>}
 */
async function loadLastStatusId(){
	try {
		const raw = await fs.readFile(STATE_FILE, "utf8");
		return JSON.parse(raw).lastStatusId ?? null;
	} 
    catch {
		return null;
	}
};

/**
 * Persists the given status ID as the last one processed.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function saveLastStatusId(id){
	await fs.writeFile(STATE_FILE, JSON.stringify({
		lastStatusId: id
	}, null, 2));
};

/**
 * Checks whether a URL points back at x.com/twitter.com itself, as opposed
 * to an external link worth surfacing.
 *
 * @param {string|null} url
 * @returns {boolean}
 */
function isInternalXUrl(url){
	if (!url) return true;
	return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(url);
};

/**
 * Turns the visible text of a link anchor back into a real URL, when
 * possible. Returns null for anything X has already truncated with an
 * ellipsis, since there"s no safe way to reconstruct it.
 *
 * @param {string|null} value
 * @returns {string|null}
 */
function normalizeDisplayedUrl(value){
	if (!value) return null;

	const text = value.trim();

	// If X shortened the visible URL with an ellipsis, don"t attempt to reconstruct it.
	if (!text || /…|\.\.\./.test(text)) return null;

	if (/^https?:\/\//i.test(text)) return text;

	// X commonly shows "reut.rs/abc123" instead of "https://reut.rs/abc123".
	if (/^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#][^\s]*)?$/i.test(text)){
		return `https://${text}`;
	}

	return null;
};

/**
 * Reduces a status' raw anchor list down to a deduplicated list of
 * external links worth including in the Discord embed.
 *
 * @param {Array<object>} [anchors]
 * @returns {string[]}
 */
function extractLinks(anchors = []){
	const links = [];

	for (const anchor of anchors){
		const href = anchor?.href || null;
		if (!href || isInternalXUrl(href)) continue;

		if (anchor.source === "text"){
			const displayed = normalizeDisplayedUrl(anchor.text);
			const title = normalizeDisplayedUrl(anchor.title);
			links.push(displayed || title || href);
		} 
        else {
			// Invisible/card link: keep the href as-is (don't follow t.co redirects that would slow the monitor down for no real benefit).
			links.push(href);
		}
	}

	return [...new Set(links)];
};

/**
 * Builds the text body for a status, appending permalinks for any video attachments beyond the first so multi video posts aren"t missing links.
 *
 * @param {object} status
 * @returns {string}
 */
function buildStatusDescription(status){
	// inside the status text.
	let description = status.text || "";

	if (status.videoCount > 0 && status.permalink){
		// X numbers multi-media permalinks (photo/1, photo/2, video/1, video/2...)
		// by attachment position, so link every video attachment, not just #1.
		const videoUrls = Array.from({
				length: status.videoCount
			},
			(_, index) => `${status.permalink}/video/${index + 1}`
		).filter((videoUrl) => !description.includes(videoUrl));

		if (videoUrls.length){
			description = [description, ...videoUrls].filter(Boolean).join("\n");
		}
	}

	return description.trim();
};

/**
 * Runs inside the page via page.$$eval. Kept as a single function so
 * Playwright can serialize it; must not reference outer closure state.
 *
 * Note: selectors like `[data-testid="tweet"]` / `[data-testid="tweetText"]`
 * below are X"s own DOM attribute names, not our naming — they have to stay
 * exactly as X wrote them for the selectors to keep matching.
 *
 * @param {Element[]} articles
 * @param {string} monitoredUsername
 * @returns {object[]}
 */
function extractStatusesFromDom(articles, monitoredUsername){
    // Builds the status text directly from the page instead of using `innerText`.
    // This prevents URLs from being split by line breaks when the browser wraps
    // them visually. It also keeps emojis that X displays as images.
	function getStatusText(el){
		if (!el) return "";

		let result = "";

		for (const node of el.childNodes){
			if (node.nodeType === Node.TEXT_NODE){
				result += node.textContent;
			} 
            else if (node.nodeName === "BR"){
				result += "\n";
			} 
            else if (node.nodeName === "IMG"){
				result += node.getAttribute("alt") || "";
			} 
            else {
				result += getStatusText(node);
			}
		}

		return result;
	}

	return articles.map((article) => {
		const isPinned = /^Pinned/i.test(article.innerText);

		const timeElement = article.querySelector('a[href*="/status/"] time');
		const statusLink = timeElement?.closest("a");
		const permalink = statusLink?.href || null;
		const id = permalink?.match(/status\/(\d+)/)?.[1] || null;

		const authorUsername =
			permalink?.match(/(?:x|twitter)\.com\/([^/]+)\/status\//i)?.[1] || monitoredUsername;

		const textElement = article.querySelector('[data-testid="tweetText"]');
		const text = getStatusText(textElement).trim();

		const textAnchors = Array.from(textElement?.querySelectorAll("a[href]") || []).map(
			(anchor) => ({
				href: anchor.href,
				text: anchor.textContent?.trim() || "",
				title: anchor.getAttribute("title") || "",
				source: "text",
			})
		);

		const cardElement = article.querySelector(
			'[data-testid="card.wrapper"], [data-testid="card.layoutLarge.media"], [data-testid="card.layoutSmall.media"]'
		);

		const cardAnchors = [];

		if (cardElement){
			const outerAnchor = cardElement.closest("a[href]");
			if (outerAnchor){
				cardAnchors.push({
					href: outerAnchor.href,
					text: outerAnchor.textContent?.trim() || "",
					title: outerAnchor.getAttribute("title") || "",
					source: "card",
				});
			}

			if (cardElement.matches?.("a[href]")){
				cardAnchors.push({
					href: cardElement.href,
					text: cardElement.textContent?.trim() || "",
					title: cardElement.getAttribute("title") || "",
					source: "card",
				});
			}

			for (const anchor of cardElement.querySelectorAll("a[href]")){
				cardAnchors.push({
					href: anchor.href,
					text: anchor.textContent?.trim() || "",
					title: anchor.getAttribute("title") || "",
					source: "card",
				});
			}
		}

		const tcoAnchors = Array.from(article.querySelectorAll('a[href^="https://t.co/"]')).map(
			(anchor) => ({
				href: anchor.href,
				text: anchor.textContent?.trim() || "",
				title: anchor.getAttribute("title") || "",
				source: "card",
			})
		);

		const anchors = [...textAnchors, ...cardAnchors, ...tcoAnchors];

		const photos = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'))
			.map((image) => image.src)
			.filter(Boolean);

		// preview image
		const cardImages = Array.from(cardElement?.querySelectorAll("img") || []).sort((a, b) => {
			const aArea = (a.naturalWidth || 0) * (a.naturalHeight || 0);
			const bArea = (b.naturalWidth || 0) * (b.naturalHeight || 0);
			return bArea - aArea;
		});

		const cardImage = cardImages[0]?.src || null;

		// Count distinct video attachments. Prefer the per-attachment wrapper
		// testid X uses (one per video); if that"s absent for some reason, fall
		// back to counting raw <video> elements.
		const videoPlayers = article.querySelectorAll('[data-testid="videoPlayer"]');
		const videoCount = videoPlayers.length || article.querySelectorAll("video").length;

		const userNameBlock = article.querySelector('[data-testid="User-Name"]');
		const authorProfileAnchor = Array.from(userNameBlock?.querySelectorAll("a") || []).find(
			(anchor) => {
				try {
					return (
						new URL(anchor.href).pathname.replace(/\/$/, "").toLowerCase() ===
						`/${authorUsername}`.toLowerCase()
					);
				} 
                catch {
					return false;
				}
			}
		);

		const authorName =
			Array.from(authorProfileAnchor?.querySelectorAll("span") || [])
			.map((span) => span.textContent?.trim())
			.find((value) => value && !value.startsWith("@") && value !== "·") || authorUsername;

		const authorIcon =
			article.querySelector('[data-testid="Tweet-User-Avatar"] img')?.src ||
			article.querySelector('img[src*="profile_images"]')?.src ||
			null;

		return {
			isPinned,
			id,
			permalink,
			timestamp: timeElement?.getAttribute("datetime") || null,
			authorUsername,
			authorName,
			authorIcon,
			text,
			anchors,
			photos,
			cardImage,
			videoCount,
		};
	});
};


/**
 * Loads the target account"s timeline and extracts the visible statuses.
 *
 * @param {import("playwright").Page} page
 * @param {string} username
 * @returns {Promise<object[]>}
 */
async function fetchRecentStatuses(page, username){
	await page.goto(`https://x.com/${username}`, {
		waitUntil: "domcontentloaded",
		timeout: navTimeoutMs,
	});

	await page.waitForSelector('article[data-testid="tweet"]', {
		timeout: statusWaitTimeoutMs,
	});

	// X lazy-loads link-card previews (image + headline) as each status
	// scrolls into view. The first few statuses are usually below the fold
	// of a real timeline, so their cards haven"t fetched yet right after
	// load. Scroll down through the timeline once (pausing so lazy-loaded
	// requests can fire) and back up before reading the DOM.
	await page.evaluate(async () => {
		const step = Math.floor(window.innerHeight * 0.8);

		for (let i = 0; i < 4; i++){
			window.scrollBy(0, step);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		window.scrollTo(0, 0);
	});

	// Settle window for the scrolled-into-view cards/images to actually land.
	await page.waitForTimeout(cardSettleMs);

	const statuses = await page.$$eval(
		'article[data-testid="tweet"]',
		extractStatusesFromDom,
		username
	);

	const validStatuses = statuses.filter(
		(status) => !status.isPinned && status.id && status.permalink
	);

	for (const status of validStatuses){
		status.links = extractLinks(status.anchors);
		status.authorIcon = upscaleProfileImage(status.authorIcon);
	}

	return validStatuses;
};


/**
 * Webhook details.
 *
 * @param {string[]} [links]
 * @returns {object|null}
 */
function buildLinkField(links = []){
	if (!links.length) return null;

	return {
		name: "Link Detected",
		value: `\`\`\`${truncate(links.join("\n"), 1018)}\`\`\``,
		inline: false,
	};
};

/**
 * Turns a scraped status into a Discord webhook payload.
 *
 * @param {object} status
 * @returns {object}
 */
function buildDiscordPayload(status){
	const description = buildStatusDescription(status);
	const linkField = buildLinkField(status.links);

	const embed = {
		title: "New Status",
		url: status.permalink,
		color: 0,
		author: {
			name: status.authorName || status.authorUsername,
			url: `https://x.com/${status.authorUsername}`,
			...(status.authorIcon ? {
				icon_url: status.authorIcon
			} : {}),
		},
		footer: {
			text: webhookName,
			...(webhookIcon ? {
				icon_url: webhookIcon
			} : {}),
		},
		timestamp: status.timestamp || new Date().toISOString(),
	};

	// Don't send an empty description on a link only status.
	if (description) embed.description = truncate(description, 4096);
	if (linkField) embed.fields = [linkField];

	// Prefer a real status photo; fall back to the link-card preview image.
	const displayImage = status.photos?.[0] || status.cardImage || null;
	if (displayImage) embed.image = {
		url: displayImage
	};

	const embeds = [embed];

	for (const photo of (status.photos || []).slice(1, 4)){
		embeds.push({
			url: status.permalink,
			image: {
				url: photo
			}
		});
	}

	return {
		content: null,
		username: webhookName,
		...(webhookIcon ? {
			avatar_url: webhookIcon
		} : {}),
		embeds,
		attachments: [],
		allowed_mentions: {
			parse: []
		},
	};
};

/**
 * POSTs to the Discord webhook, retrying on 429 (rate limit)
 *
 * @param {object} payload
 * @param {number} [attempt]
 * @returns {Promise<void>}
 */
async function sendJsonWebhook(payload, attempt = 1){
	const response = await fetchWithTimeout(DISCORD_WEBHOOK_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify(payload),
	});

	if (response.ok) return;

	const retryable = response.status === 429 || response.status >= 500;

	if (retryable && attempt < discordMaxRetries){
		const retryAfterHeader = Number(response.headers.get("retry-after"));
		const delayMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ?
			retryAfterHeader * 1000 :
			attempt * 1000;

		log("WARN", `Discord webhook returned ${response.status}; retrying in ${delayMs}ms.`);
		await sleep(delayMs);
		return sendJsonWebhook(payload, attempt + 1);
	}

	const body = await response.text();
	throw new Error(`Discord webhook failed: ${response.status} ${body}`);
};

/**
 * Sends a status to Discord.
 *
 * @param {object} status
 * @returns {Promise<void>}
 */
async function sendToDiscord(status){
	await sendJsonWebhook(buildDiscordPayload(status));
};

/**
 * Compares the freshly fetched statuses against the last known one, sends
 * whatever"s new to Discord (oldest first), and returns the new "last
 * known" ID to persist.
 *
 * @param {object[]} statuses
 * @param {string|null} lastStatusId
 * @returns {Promise<string>}
 */
async function processNewStatuses(statuses, lastStatusId){
	const latestStatus = statuses[0];

	if (!lastStatusId){
		if (NOTIFY_ON_STARTUP){
			log("NEW", `Startup status found: ${latestStatus.permalink}`);
			await sendToDiscord(latestStatus);
			log("DISCORD", "Startup status sent to Discord.");
		} 
        else {
			log("INIT", `Baseline status: ${latestStatus.permalink}`);
		}

		await saveLastStatusId(latestStatus.id);
		return latestStatus.id;
	}

	const knownIndex = statuses.findIndex((status) => status.id === lastStatusId);
	let newStatuses = [];

	if (knownIndex > 0){
		// Everything above the previously known status is new.
		newStatuses = statuses.slice(0, knownIndex);
	} 
    else if (knownIndex === -1 && latestStatus.id !== lastStatusId){
		// just to not spam Discord with a backlog of old statuses.
		log("WARN", "Previous status ID was not found in the visible timeline.");
		newStatuses = [latestStatus];
	}

	if (!newStatuses.length){
		log("OK", `No new statuses from this account.`);
		return lastStatusId;
	}

	// X returns newest -> oldest; send to Discord oldest -> newest.
	newStatuses.reverse();
	log("NEW", `${newStatuses.length} new status${newStatuses.length === 1 ? "" : "es"} found.`);

	let latestSentId = lastStatusId;

	for (const status of newStatuses){
		log("SEND", `Sending ${status.permalink}`);
		await sendToDiscord(status);

		latestSentId = status.id;
		await saveLastStatusId(status.id);

		log("DISCORD", `Status ${status.id} posted successfully.`);
	}

	return latestSentId;
};

/**
 * Runs the poll loop: fetch statuses, process anything new, wait, repeat —
 * until shutdown is requested.
 *
 * @param {import("playwright").BrowserContext} context
 * @param {string} username
 * @returns {Promise<void>}
 */
async function monitor(context, username){
	let lastStatusId = await loadLastStatusId();

	log("STATE", lastStatusId ?
		`Loaded last known status ID: ${lastStatusId}` :
		"No previous status state found.");

	let page = await context.newPage();
	page.setDefaultTimeout(navTimeoutMs);

	let iteration = 0;
	let consecutiveErrors = 0;

	while (!shutdownRequested){
		try {
			// Recycle the page periodically — long-lived Playwright pages on a
			// heavy SPA like X can accumulate detached DOM/listener memory.
			if (iteration > 0 && iteration % pageRecycleEvery === 0){
				log("MAINT", "Recycling browser page to keep memory usage stable.");
				await page.close().catch(() => {});
				page = await context.newPage();
				page.setDefaultTimeout(navTimeoutMs);
			}

			log("CHECK", `Checking @${username} for new statuses...`);
			const statuses = await fetchRecentStatuses(page, username);

			if (!statuses.length){
				log("WARN", `No statuses found for @${username}.`);
			} 
            else {
				lastStatusId = await processNewStatuses(statuses, lastStatusId);
			}

			consecutiveErrors = 0;
		} 
        catch (error){
			consecutiveErrors += 1;
			log("ERROR", error?.message || String(error));
			log("RETRY", `Monitor will continue running (${consecutiveErrors} consecutive error${consecutiveErrors === 1 ? "" : "s"}).`);

			// A run of failures usually means the page/session is in a bad state
			// (ex. a stuck navigation) — force a fresh page next time.
			if (consecutiveErrors >= 3){
				log("MAINT", "Multiple consecutive failures; forcing a fresh page.");
				await page.close().catch(() => {});
				page = await context.newPage();
				page.setDefaultTimeout(navTimeoutMs);
				consecutiveErrors = 0;
			}
		}

		iteration += 1;

		if (!shutdownRequested){
			const jitter = Math.floor(Math.random() * pollJitterMs);
			const waitMs = monitorDelay + jitter;

			log("WAIT", `Next check in ${(waitMs / 1000).toFixed(1)} seconds.`);
			await sleep(waitMs);
		}
	}

	await page.close().catch(() => {});
};

/**
 * Flags the monitor loop to stop after its current iteration and wakes it
 * up early if it"s mid-sleep.
 *
 * @param {string} signal - The signal name that triggered shutdown.
 */
function requestShutdown(signal){
	if (shutdownRequested) return;

	shutdownRequested = true;
	log("STOP", `${signal} received. Shutting down...`);

	if (wakeSleep) wakeSleep();
};

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

/**
 * Entry point: validates config, launches the browser, logs into X with
 * the provided session cookies, and hands off to the monitor loop.
 */
async function main(){
	requireEnv();

	const username = TWITTER_USERNAME.trim().replace(/^@/, "");

	log("START", `Starting X monitor for @${username}.`);
	log("START", `Polling every ${(monitorDelay / 1000).toFixed(1)} seconds (+ jitter).`);

	const browser = await chromium.launch({
		headless: true
	});

	try {
		const context = await browser.newContext({
			userAgent
		});

		await context.addCookies([{
				name: "auth_token",
				value: TWITTER_AUTH_TOKEN,
				domain: ".x.com",
				path: "/",
				httpOnly: true,
				secure: true,
			},
			{
				name: "ct0",
				value: TWITTER_CT0,
				domain: ".x.com",
				path: "/",
				secure: true,
			},
		]);

		await monitor(context, username);
	} finally {
		log("STOP", "Closing browser...");
		await browser.close();
		log("STOP", "X monitor stopped.");
	}
};

main().catch((error) => {
	log("FATAL", error?.stack || error?.message || String(error));
	process.exit(1);
});