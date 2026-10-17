import { createServer } from 'http';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

const FEED = '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1';
const ABI = [
  { name: 'latestRoundData', type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' },
    { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' },
    { name: 'answeredInRound', type: 'uint80' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

const client = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') });

createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const [rd, dec] = await Promise.all([
          client.readContract({ address: FEED, abi: ABI, functionName: 'latestRoundData' }),
          client.readContract({ address: FEED, abi: ABI, functionName: 'decimals' }),
        ]);
        const report = {
          feed: 'ETH/USD', address: FEED,
          price: (Number(rd[1]) / 10 ** dec).toFixed(2),
          roundId: rd[0].toString(), updatedAt: new Date(Number(rd[3]) * 1000).toISOString(),
          source: 'chainlink-cre-workflow-simulated',
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (e) { res.writeHead(500); res.end('feed read failed'); }
    });
  } else { res.writeHead(404); res.end(); }
}).listen(2000, () => console.log('mock CRE simulator on :2000'));
