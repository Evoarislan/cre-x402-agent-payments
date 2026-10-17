/**
 * Demo buyer agent: pays for an oracle query through the x402 gateway.
 *
 * 1. POST /query without payment -> expect 402 + x402 v2 challenge.
 * 2. Build an EIP-3009 TransferWithAuthorization from the challenge and sign
 *    it with a throwaway test key (Base Sepolia USDC domain).
 * 3. POST /query with the PAYMENT-SIGNATURE header -> expect the oracle report.
 *
 * Run: npx tsx src/agent-pay.ts
 * Env: GATEWAY_URL (default http://localhost:4021), plus the gateway's
 * USDC_ADDRESS / X402_CHAIN_ID so the signature domain matches.
 */
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import { privateKeyToAccount, signTypedData } from 'viem/accounts';

const GATEWAY_URL = (process.env.GATEWAY_URL ?? 'http://localhost:4021').replace(/\/$/, '');
const USDC_ADDRESS = (process.env.USDC_ADDRESS ??
	'0x036CbD53842c5426634e7929541eC2318f3dCF7e') as Hex;
const CHAIN_ID = Number(process.env.X402_CHAIN_ID ?? '84532');

// Throwaway key for the demo only, generated fresh on every run.
// Never fund it, never reuse it for anything real.
const DEMO_PRIVATE_KEY = `0x${randomBytes(32).toString('hex')}` as Hex;
const account = privateKeyToAccount(DEMO_PRIVATE_KEY);

const EIP3009_TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
} as const;

type Challenge = {
	x402Version: number;
	accepts: {
		scheme: string;
		network: string;
		amount: string;
		asset: string;
		payTo: string;
		maxTimeoutSeconds: number;
	}[];
};

async function main() {
	console.log('--- step 1: unpaid request, expect 402 ---');
	const unpaid = await fetch(`${GATEWAY_URL}/query`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ feedName: 'ETH/USD' }),
	});
	console.log('status:', unpaid.status);
	const challenge = (await unpaid.json()) as Challenge;
	if (unpaid.status !== 402 || challenge.x402Version !== 2) {
		throw new Error('Expected a 402 x402 v2 challenge');
	}
	const req = challenge.accepts[0];
	console.log(
		`challenge: pay ${req.amount} USDC-wei to ${req.payTo} on ${req.network} (scheme=${req.scheme})`,
	);

	console.log('--- step 2: sign EIP-3009 authorization ---');
	const nowSec = Math.floor(Date.now() / 1000);
	const authorization = {
		from: account.address,
		to: req.payTo as Hex,
		value: BigInt(req.amount),
		validAfter: 0n,
		validBefore: BigInt(nowSec + Math.min(req.maxTimeoutSeconds, 600)),
		nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
	};
	const signature = await signTypedData({
		privateKey: DEMO_PRIVATE_KEY,
		domain: {
			name: 'USDC',
			version: '2',
			chainId: CHAIN_ID,
			verifyingContract: USDC_ADDRESS,
		},
		types: EIP3009_TYPES,
		primaryType: 'TransferWithAuthorization',
		message: authorization,
	});
	const header = Buffer.from(
		JSON.stringify({
			x402Version: 2,
			payload: {
				signature,
				authorization: {
					from: authorization.from,
					to: authorization.to,
					value: authorization.value.toString(),
					validAfter: authorization.validAfter.toString(),
					validBefore: authorization.validBefore.toString(),
					nonce: authorization.nonce,
				},
			},
		}),
		'utf-8',
	).toString('base64');
	console.log(`signed by ${account.address}`);

	console.log('--- step 3: paid request, expect the oracle report ---');
	const paid = await fetch(`${GATEWAY_URL}/query`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'payment-signature': header },
		body: JSON.stringify({ feedName: 'ETH/USD' }),
	});
	console.log('status:', paid.status);
	const body = await paid.text();
	console.log(body.slice(0, 2000));
	if (paid.status === 502) {
		console.log(
			'\nNOTE: the gateway is up and the payment verified, but the CRE simulator ' +
				'is not running. Start it with:\n' +
				'  cre workflow simulate oracle-query-workflow --target staging-settings --listen',
		);
	}
}

main().catch((err) => {
	console.error('demo agent failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
