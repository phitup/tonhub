import axios from "axios";
import * as t from 'io-ts';

const apyCodec = t.type({
    apy: t.string
});

export type StakingAPY = {
    apy: number
};

export async function fetchApy(isTestnet: boolean) {
    const res = ((await axios.get(`https://connect.tonhubapi.com/net/${isTestnet ? 'testnet' : 'mainnet'}/elections/latest/apy`, { method: 'GET' })).data);
    if (!apyCodec.is(res)) {
        throw Error('Invalid apy');
    }

    return { apy: parseFloat(res.apy) } as StakingAPY;
}