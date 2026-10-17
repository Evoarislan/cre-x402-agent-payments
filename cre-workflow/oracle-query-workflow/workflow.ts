/**
 * Pay-per-query oracle workflow.
 *
 * Trigger: HTTP (called by the x402 gateway after payment verification).
 * Logic: reads a Chainlink price feed on the configured chain via the EVM
 * capability and returns a JSON report { feed, answer, scaled, decimals,
 * roundId, updatedAt }.
 *
 * This is a generic oracle-query service. Any AI agent that pays through the
 * x402 gateway can consume it; the workflow itself knows nothing about
 * payments.
 */
import {
	bytesToHex,
	cre,
	encodeCallMsg,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	type HTTPPayload,
	type Runtime,
} from '@chainlink/cre-sdk';
import {
	decodeFunctionResult,
	encodeFunctionData,
	formatUnits,
	zeroAddress,
	type Address,
} from 'viem';
import { z } from 'zod';

// ---------- Config ----------

export const configSchema = z.object({
	/** CRE chain selector name, e.g. "ethereum-testnet-sepolia-base-1". */
	chainName: z.string(),
	/** True for testnets (Base Sepolia), false for mainnet chains. */
	isTestnet: z.boolean(),
	/** Default feed when the trigger payload does not override it. */
	feed: z.object({
		name: z.string(),
		address: z.string(),
	}),
	/** Informational: price per query in USDC charged by the gateway. */
	priceUsdc: z.string(),
});

type Config = z.infer<typeof configSchema>;

// ---------- Minimal AggregatorV3 binding ----------

const AGGREGATOR_ABI = [
	{
		inputs: [],
		name: 'decimals',
		outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'latestRoundData',
		outputs: [
			{ internalType: 'uint80', name: 'roundId', type: 'uint80' },
			{ internalType: 'int256', name: 'answer', type: 'int256' },
			{ internalType: 'uint256', name: 'startedAt', type: 'uint256' },
			{ internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
			{ internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;

type QueryReport = {
	feed: string;
	feedAddress: string;
	chain: string;
	decimals: number;
	answerRaw: string;
	answerScaled: string;
	roundId: string;
	updatedAt: string;
	updatedAtIso: string;
	servedAt: string;
};

const safeJsonStringify = (obj: unknown) =>
	JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

function getEvmClient(chainName: string, isTestnet: boolean) {
	const net = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: chainName,
		isTestnet,
	});
	if (!net) {
		throw new Error(`Network not found for chain selector name: ${chainName}`);
	}
	return new cre.capabilities.EVMClient(net.chainSelector.selector);
}

function readFeed(
	runtime: Runtime<Config>,
	feedName: string,
	feedAddress: Address,
): QueryReport {
	const client = getEvmClient(runtime.config.chainName, runtime.config.isTestnet);

	const decimalsCall = encodeFunctionData({ abi: AGGREGATOR_ABI, functionName: 'decimals' });
	const decimalsResult = client
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: feedAddress, data: decimalsCall }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result();
	const decimals = decodeFunctionResult({
		abi: AGGREGATOR_ABI,
		functionName: 'decimals',
		data: bytesToHex(decimalsResult.data),
	}) as number;

	const roundCall = encodeFunctionData({ abi: AGGREGATOR_ABI, functionName: 'latestRoundData' });
	const roundResult = client
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: feedAddress, data: roundCall }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result();
	const [roundId, answer, , updatedAt] = decodeFunctionResult({
		abi: AGGREGATOR_ABI,
		functionName: 'latestRoundData',
		data: bytesToHex(roundResult.data),
	}) as unknown as [bigint, bigint, bigint, bigint, bigint];

	const scaled = formatUnits(answer, decimals);
	runtime.log(
		`Oracle query served | feed="${feedName}" answer=${scaled} roundId=${roundId.toString()}`,
	);

	return {
		feed: feedName,
		feedAddress,
		chain: runtime.config.chainName,
		decimals,
		answerRaw: answer.toString(),
		answerScaled: scaled,
		roundId: roundId.toString(),
		updatedAt: updatedAt.toString(),
		updatedAtIso: new Date(Number(updatedAt) * 1000).toISOString(),
		servedAt: new Date().toISOString(),
	};
}

// ---------- Handler ----------

type TriggerPayload = {
	/** Optional override of the configured feed address (0x...). */
	feedAddress?: string;
	/** Optional label for the report. */
	feedName?: string;
};

export function onHttpTrigger(runtime: Runtime<Config>, payload: HTTPPayload): string {
	let requested: TriggerPayload = {};
	if (payload.input && payload.input.length > 0) {
		try {
			requested = JSON.parse(Buffer.from(payload.input).toString('utf-8')) as TriggerPayload;
		} catch {
			throw new Error('HTTP trigger payload is not valid JSON');
		}
	}

	const feedAddress = (requested.feedAddress ?? runtime.config.feed.address) as Address;
	const feedName = requested.feedName ?? runtime.config.feed.name;

	if (!/^0x[0-9a-fA-F]{40}$/.test(feedAddress)) {
		throw new Error(`Invalid feed address: ${feedAddress}`);
	}

	const report = readFeed(runtime, feedName, feedAddress);
	return safeJsonStringify(report);
}

// ---------- Init ----------

export function initWorkflow(_config: Config) {
	const http = new cre.capabilities.HTTPCapability();
	return [cre.handler(http.trigger({}), onHttpTrigger)];
}
