/** Runtime configuration for the gateway, loaded from environment. */
export type GatewayConfig = {
	port: number;
	payTo: string;
	priceUsdc: string;
	network: string;
	usdcAddress: string;
	chainId: number;
	maxTimeoutSeconds: number;
	creSimulatorUrl: string;
};

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function required(name: string): string {
	const v = process.env[name];
	if (!v || v.trim() === '') {
		throw new Error(`Missing required env var ${name} (see .env.example)`);
	}
	return v.trim();
}

/** Parse "0.05" into raw USDC units (6 decimals). */
export function parseUsdcToRaw(value: string): bigint {
	if (!/^\d+(\.\d{1,6})?$/.test(value)) {
		throw new Error(`Invalid USDC amount "${value}"`);
	}
	const [whole = '0', frac = ''] = value.split('.');
	return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

export function loadConfig(): GatewayConfig {
	const payTo = required('PAY_TO');
	if (!HEX_ADDRESS_RE.test(payTo)) {
		throw new Error('PAY_TO is not a valid 0x address');
	}
	const usdcAddress = (
		process.env.USDC_ADDRESS ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
	).trim();
	if (!HEX_ADDRESS_RE.test(usdcAddress)) {
		throw new Error('USDC_ADDRESS is not a valid 0x address');
	}
	return {
		port: Number(process.env.PORT ?? '4021'),
		payTo,
		priceUsdc: process.env.PRICE_USDC ?? '0.05',
		network: process.env.X402_NETWORK ?? 'eip155:84532',
		usdcAddress,
		chainId: Number(process.env.X402_CHAIN_ID ?? '84532'),
		maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT ?? '600'),
		creSimulatorUrl: (process.env.CRE_SIMULATOR_URL ?? 'http://localhost:2000').replace(
			/\/$/,
			'',
		),
	};
}
