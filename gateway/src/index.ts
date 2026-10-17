/**
 * x402 payment gateway for the CRE oracle-query workflow.
 *
 * POST /query
 *   - No (or invalid) PAYMENT-SIGNATURE header -> 402 + x402 v2 challenge.
 *   - Valid payment -> forwards the request body to the CRE workflow
 *     simulator (started separately with `cre workflow simulate --listen`)
 *     and returns the workflow's oracle report.
 * GET /health -> { ok: true }
 *
 * Plain node:http, no framework. Run with: npx tsx src/index.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, parseUsdcToRaw } from './config.js';
import { buildChallenge, verifyPaymentSignature } from './x402.js';

const cfg = loadConfig();
const amountRaw = parseUsdcToRaw(cfg.priceUsdc);

/** Nonces already spent (in-memory replay protection). */
const spentNonces = new Set<string>();

function sendJson(res: ServerResponse, status: number, body: unknown) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(text),
	});
	res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}

function extractNonce(headerValue: string | undefined): string | null {
	if (!headerValue) return null;
	try {
		const decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf-8')) as {
			payload?: { authorization?: { nonce?: string } };
		};
		const nonce = decoded?.payload?.authorization?.nonce;
		return typeof nonce === 'string' ? nonce : null;
	} catch {
		return null;
	}
}

async function forwardToCre(bodyText: string): Promise<{ status: number; text: string }> {
	const res = await fetch(cfg.creSimulatorUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: bodyText || '{}',
		signal: AbortSignal.timeout(120_000),
	});
	return { status: res.status, text: await res.text() };
}

const server = createServer(async (req, res) => {
	try {
		if (req.method === 'GET' && req.url === '/health') {
			sendJson(res, 200, { ok: true, priceUsdc: cfg.priceUsdc, network: cfg.network });
			return;
		}

		if (req.method !== 'POST' || (req.url !== '/query' && req.url !== '/')) {
			sendJson(res, 404, { error: 'Not found. POST /query to buy an oracle report.' });
			return;
		}

		const header = req.headers['payment-signature'] as string | undefined;
		const verification = await verifyPaymentSignature(
			header,
			{
				network: cfg.network,
				usdcAddress: cfg.usdcAddress,
				chainId: cfg.chainId,
				payTo: cfg.payTo,
				amountRaw,
				maxTimeoutSeconds: cfg.maxTimeoutSeconds,
			},
		);

		if (!verification.ok) {
			// Not paid (or badly paid): issue the x402 v2 challenge.
			const challenge = buildChallenge({
				network: cfg.network,
				usdcAddress: cfg.usdcAddress,
				chainId: cfg.chainId,
				payTo: cfg.payTo,
				amountRaw,
				maxTimeoutSeconds: cfg.maxTimeoutSeconds,
			});
			sendJson(res, 402, challenge);
			return;
		}

		// Replay protection: each authorization nonce pays for exactly one query.
		const nonce = extractNonce(header);
		if (!nonce || spentNonces.has(nonce.toLowerCase())) {
			sendJson(res, 402, { error: 'Payment already spent or missing nonce' });
			return;
		}
		spentNonces.add(nonce.toLowerCase());

		const bodyText = await readBody(req);
		let creResult: { status: number; text: string };
		try {
			creResult = await forwardToCre(bodyText);
		} catch (err) {
			sendJson(res, 502, {
				error:
					'CRE workflow simulator is not reachable. Start it with: ' +
					'cre workflow simulate oracle-query-workflow --target staging-settings --listen',
				detail: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		let report: unknown = creResult.text;
		try {
			report = JSON.parse(creResult.text);
		} catch {
			// keep raw text
		}
		sendJson(res, creResult.status, {
			paid: true,
			payer: verification.from,
			priceUsdc: cfg.priceUsdc,
			report,
		});
	} catch (err) {
		sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
	}
});

server.listen(cfg.port, () => {
	console.log(`x402 gateway listening on http://localhost:${cfg.port}`);
	console.log(`price: ${cfg.priceUsdc} USDC on ${cfg.network} -> ${cfg.payTo}`);
	console.log(`CRE simulator: ${cfg.creSimulatorUrl}`);
});
