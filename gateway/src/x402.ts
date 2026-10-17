/**
 * x402 v2 payment challenge builder and PAYMENT-SIGNATURE verifier.
 *
 * The gateway is the seller: it mints 402 challenges for the exact/USDC
 * scheme and verifies the EIP-3009 TransferWithAuthorization the buyer signs.
 * Pure logic plus viem for signature recovery; no framework needed.
 */
import { recoverTypedDataAddress, type Hex } from 'viem';

export type X402Config = {
	/** e.g. "eip155:84532" for Base Sepolia. */
	network: string;
	/** USDC contract address on the payment network. */
	usdcAddress: string;
	/** EIP-3009 domain chain id (84532 for Base Sepolia). */
	chainId: number;
	/** USDC recipient (the seller). */
	payTo: string;
	/** Price per query in raw USDC units (6 decimals), e.g. 50000 = $0.05. */
	amountRaw: bigint;
	/** Challenge validity window in seconds. */
	maxTimeoutSeconds: number;
};

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const EIP3009_TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
} as const;

export type Authorization = {
	from: string;
	to: string;
	value: string;
	validAfter: string;
	validBefore: string;
	nonce: string;
};

/** Build the x402 v2 402 response body for POST /query. */
export function buildChallenge(cfg: X402Config) {
	return {
		x402Version: 2,
		error: 'Payment required: this oracle query costs 0.05 USDC on Base Sepolia.',
		accepts: [
			{
				scheme: 'exact',
				network: cfg.network,
				amount: cfg.amountRaw.toString(),
				asset: cfg.usdcAddress,
				payTo: cfg.payTo,
				maxTimeoutSeconds: cfg.maxTimeoutSeconds,
				extra: { name: 'USDC', version: '2' },
			},
		],
	};
}

export type VerifyResult =
	| { ok: true; from: string }
	| { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Verify an x402 v2 PAYMENT-SIGNATURE header value.
 * Checks: base64 JSON shape, authorization fields match our terms, time
 * window, and that the signature recovers to the claimed `from` address.
 * Callers should also enforce one-time nonce use (replay protection).
 */
export async function verifyPaymentSignature(
	headerValue: string | undefined,
	cfg: X402Config,
	nowSec: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
	if (!headerValue) {
		return { ok: false, error: 'Missing PAYMENT-SIGNATURE header' };
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf-8'));
	} catch {
		return { ok: false, error: 'PAYMENT-SIGNATURE is not valid base64 JSON' };
	}
	if (!isRecord(decoded) || decoded.x402Version !== 2 || !isRecord(decoded.payload)) {
		return { ok: false, error: 'Not an x402 v2 payment payload' };
	}
	const { signature, authorization } = decoded.payload as {
		signature: unknown;
		authorization: unknown;
	};
	if (typeof signature !== 'string' || !isRecord(authorization)) {
		return { ok: false, error: 'Malformed payment payload' };
	}
	const auth = authorization as Record<string, unknown>;
	const fields: (keyof Authorization)[] = [
		'from',
		'to',
		'value',
		'validAfter',
		'validBefore',
		'nonce',
	];
	for (const f of fields) {
		if (typeof auth[f] !== 'string' || (auth[f] as string).length === 0) {
			return { ok: false, error: `Authorization missing field: ${f}` };
		}
	}
	const a = auth as unknown as Authorization;

	if (!HEX_ADDRESS_RE.test(a.from) || !HEX_ADDRESS_RE.test(a.to)) {
		return { ok: false, error: 'Authorization has invalid addresses' };
	}
	if (a.to.toLowerCase() !== cfg.payTo.toLowerCase()) {
		return { ok: false, error: 'Authorization pays the wrong recipient' };
	}
	let value: bigint;
	try {
		value = BigInt(a.value);
	} catch {
		return { ok: false, error: 'Authorization value is not an integer' };
	}
	if (value !== cfg.amountRaw) {
		return { ok: false, error: `Authorization value ${a.value} does not match price ${cfg.amountRaw}` };
	}
	const validAfter = Number(a.validAfter);
	const validBefore = Number(a.validBefore);
	if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) {
		return { ok: false, error: 'Authorization has invalid validity window' };
	}
	if (validAfter > nowSec || validBefore <= nowSec) {
		return { ok: false, error: 'Authorization is not currently valid' };
	}
	if (validBefore - nowSec > cfg.maxTimeoutSeconds + 60) {
		return { ok: false, error: 'Authorization validity exceeds the challenge window' };
	}

	let recovered: string;
	try {
		recovered = await recoverTypedDataAddress({
			domain: {
				name: 'USDC',
				version: '2',
				chainId: cfg.chainId,
				verifyingContract: cfg.usdcAddress as Hex,
			},
			types: EIP3009_TYPES,
			primaryType: 'TransferWithAuthorization',
			message: {
				from: a.from as Hex,
				to: a.to as Hex,
				value: BigInt(a.value),
				validAfter: BigInt(a.validAfter),
				validBefore: BigInt(a.validBefore),
				nonce: a.nonce as Hex,
			},
			signature: signature as Hex,
		});
	} catch {
		return { ok: false, error: 'Signature recovery failed' };
	}
	if (recovered.toLowerCase() !== a.from.toLowerCase()) {
		return { ok: false, error: 'Signature does not match the claimed payer' };
	}
	return { ok: true, from: a.from };
}
