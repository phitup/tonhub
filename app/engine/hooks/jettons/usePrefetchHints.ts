import { useEffect } from 'react';
import { useHints, useMintlessHints } from './useHints';
import { useNetwork } from '../network/useNetwork';
import { Queries } from '../../queries';
import { fetchMetadata } from '../../metadata/fetchMetadata';
import { getLastBlock } from '../../accountWatcher';
import { JettonMasterState, fetchJettonMasterContent } from '../../metadata/fetchJettonMasterContent';
import { Address } from '@ton/core';
import { StoredContractMetadata, StoredJettonWallet } from '../../metadata/StoredMetadata';
import { log } from '../../../utils/log';
import { TonClient4 } from '@ton/ton';
import { QueryClient } from '@tanstack/react-query';
import { storage } from '../../../storage/storage';
import { create, keyResolver, windowedFiniteBatchScheduler } from "@yornaath/batshit";
import { clients, queryClient } from '../../clients';
import { AsyncLock } from 'teslabot';
import memoize from '../../../utils/memoize';
import { tryFetchJettonWalletIsClaimed } from '../../metadata/introspections/tryFetchJettonWalletIsClaimed';
import { fetchMintlessHints, MintlessJetton } from '../../api/fetchMintlessHints';
import { getQueryData } from '../../utils/getQueryData';
import { fetchJettonWallet } from '../../metadata/introspections/fetchJettonWallet';
import { fetchJettonWalletAddress } from '../../metadata/introspections/fetchJettonWalletAddress';

let jettonFetchersLock = new AsyncLock();

const metadataBatcher = memoize((client: TonClient4, isTestnet: boolean) => {
    return create({
        fetcher: async (addressesString: string[]) => {
            return await jettonFetchersLock.inLock(async () => {
                log(`[contract-metadata] 🟡 batch: ${addressesString.length}`);
                let measurement = performance.now();
                let result: StoredContractMetadata[] = [];

                await Promise.all(addressesString.map(async (addressString) => {
                    try {
                        let address = Address.parse(addressString);
                        let metadata = await fetchMetadata(client, await getLastBlock(), address, isTestnet);

                        result.push({
                            jettonMaster: metadata.jettonMaster ? {
                                content: metadata.jettonMaster.content,
                                mintable: metadata.jettonMaster.mintalbe,
                                owner: metadata.jettonMaster.owner?.toString({ testOnly: isTestnet }) ?? null,
                                totalSupply: metadata.jettonMaster.totalSupply.toString(10),
                            } : null,
                            jettonWallet: metadata.jettonWallet ? {
                                balance: metadata.jettonWallet.balance.toString(10),
                                master: metadata.jettonWallet.master.toString({ testOnly: isTestnet }),
                                owner: metadata.jettonWallet.owner.toString({ testOnly: isTestnet }),
                                address: addressString,
                            } : null,
                            seqno: metadata.seqno,
                            address: address.toString({ testOnly: isTestnet }),
                        });
                    } catch {
                        console.warn(`[contract-metadata] 🔴 ${addressString}`);
                    }

                }));

                log('[contract-metadata] 🟢 in ' + (performance.now() - measurement).toFixed(1));
                return result;
            })
        },
        resolver: keyResolver('address'),
        scheduler: windowedFiniteBatchScheduler({ windowMs: 1000, maxBatchSize: 40 }),
    });
});

const masterBatcher = memoize((isTestnet: boolean) => {
    return create({
        fetcher: async (masters: string[]) => {
            return await jettonFetchersLock.inLock(async () => {
                let result: (JettonMasterState & { address: string })[] = [];
                log(`[jetton-master] 🟡 batch: ${masters.length}`);
                let measurement = performance.now();

                await Promise.all(masters.map(async (master) => {
                    try {
                        let address = Address.parse(master);
                        let masterContent = await fetchJettonMasterContent(address, isTestnet);
                        if (!masterContent) {
                            return null;
                        }

                        result.push({
                            ...masterContent,
                            address: address.toString({ testOnly: isTestnet }),
                        });
                    } catch {
                        console.warn(`[jetton-master] 🔴 ${master}`);
                    }
                }));

                log(`[jetton-master] 🟢 in ${(performance.now() - measurement).toFixed(1)}`);

                return result;
            });
        },

        resolver: keyResolver('address'),
        scheduler: windowedFiniteBatchScheduler({ windowMs: 1000, maxBatchSize: 10 })
    })
});

const walletBatcher = memoize((client: TonClient4, isTestnet: boolean) => {
    return create({
        fetcher: async (wallets: string[]) => {
            return await jettonFetchersLock.inLock(async () => {
                const result: StoredJettonWallet[] = [];
                log(`[jetton-wallet] 🟡 batch ${wallets.length}`);
                let measurement = performance.now();
                await Promise.all(wallets.map(async (wallet) => {
                    try {
                        log(`[jetton-wallet] 🟡 batch ${wallet}`);

                        const queryCache = queryClient.getQueryCache();
                        const address = Address.parse(wallet);
                        const seqno = (await client.getLastBlock()).last.seqno;
                        const data = await fetchJettonWallet(seqno, address, isTestnet);

                        if (!data) {
                            return;
                        }

                        let isClaimed: boolean | null = null

                        try {
                            isClaimed = await tryFetchJettonWalletIsClaimed(client, seqno, address);
                        } catch (error) {
                            console.warn(`[jetton-wallet] isClaimed 🔴 ${wallet}`, error);
                        }

                        let mintlessBalance;

                        if (isClaimed === false) {
                            const owner = data.owner.toString({ testOnly: isTestnet });

                            const queryKey = Queries.Mintless(owner);
                            let mintlessHints = getQueryData<MintlessJetton[]>(queryCache, queryKey) || [];

                            if (!mintlessHints) {
                                try {
                                    mintlessHints = await fetchMintlessHints(owner);
                                } catch { }
                            }

                            mintlessBalance = mintlessHints.find(hint => hint.walletAddress.address === wallet)?.balance;
                        }

                        const walletAddressKey = Queries.Jettons()
                            .Address(data.owner.toString({ testOnly: isTestnet }))
                            .Wallet(data.master.toString({ testOnly: isTestnet }));
                        const cachedWalletAddress = getQueryData(queryCache, walletAddressKey);

                        if (!cachedWalletAddress) {
                            queryClient.setQueriesData(walletAddressKey, wallet)
                        }

                        result.push({
                            balance: mintlessBalance || data.balance.toString(10),
                            master: data.master.toString({ testOnly: isTestnet }),
                            owner: data.owner.toString({ testOnly: isTestnet }),
                            address: wallet
                        });
                    } catch (error) {
                        console.warn(`[jetton-wallet] 🔴 ${wallet}`, error);
                    }
                }));
                log(`[jetton-wallet] 🟢 in ${(performance.now() - measurement).toFixed(1)}`);
                return result;
            });
        },
        resolver: keyResolver('address'),
        scheduler: windowedFiniteBatchScheduler({ windowMs: 1000, maxBatchSize: 10 })
    })
});

const walletAddressBatcher = memoize((client: TonClient4, isTestnet: boolean) => {
    return create({
        fetcher: async (args: { master: string, owner: string }[]) => {
            return await jettonFetchersLock.inLock(async () => {
                const result: { wallet: string, master: string, owner: string }[] = [];
                log(`[jetton-wallet-address] 🟡 batch ${args.length}`);
                const seqno = (await client.getLastBlock()).last.seqno;
                const measurement = performance.now();
                await Promise.all(args.map(async ({ master, owner }) => {
                    try {
                        const wallet = await fetchJettonWalletAddress(
                            seqno,
                            isTestnet,
                            { address: Address.parse(owner), master: Address.parse(master) }
                        );

                        if (!wallet) {
                            return;
                        }

                        result.push({
                            wallet: wallet.toString({ testOnly: isTestnet }),
                            master: master,
                            owner: owner
                        });
                    } catch (error) {
                        console.warn(`[jetton-wallet-address] 🔴 ${owner}`, error);
                    }
                }));
                log(`[wallet-address] 🟢 in ${(performance.now() - measurement).toFixed(1)}`);
                return result;
            });
        },
        resolver: (items: { wallet: string, master: string, owner: string }[], query) => {
            return items.find(i => (i.master === query.master && i.owner === query.owner))?.wallet ?? null;
        },
        scheduler: windowedFiniteBatchScheduler({ windowMs: 1000, maxBatchSize: 10 })
    });
});

export function contractMetadataQueryFn(isTestnet: boolean, addressString: string) {
    return async (): Promise<StoredContractMetadata> => {
        return metadataBatcher(clients.ton[isTestnet ? 'testnet' : 'mainnet'], isTestnet).fetch(addressString);
    }
}

export function jettonMasterContentQueryFn(master: string, isTestnet: boolean) {
    return async (): Promise<(JettonMasterState & { address: string }) | null> => {
        return masterBatcher(isTestnet).fetch(master);
    }
}


export function jettonWalletQueryFn(wallet: string, isTestnet: boolean) {
    return async (): Promise<StoredJettonWallet | null> => {
        return walletBatcher(clients.ton[isTestnet ? 'testnet' : 'mainnet'], isTestnet).fetch(wallet);
    }
}

export function jettonWalletAddressQueryFn(master: string, owner: string, isTestnet: boolean) {
    return async (): Promise<string | null> => {
        return walletAddressBatcher(clients.ton[isTestnet ? 'testnet' : 'mainnet'], isTestnet).fetch({ master, owner });
    }
}

const currentJettonsVersion = 3;
const jettonsVersionKey = 'jettons-version';

function invalidateJettonsDataIfVersionChanged(queryClient: QueryClient) {
    try {
        const lastVersion = storage.getNumber(jettonsVersionKey);

        if (!lastVersion || lastVersion < currentJettonsVersion) {
            storage.set(jettonsVersionKey, currentJettonsVersion);
            queryClient.invalidateQueries(['jettons', 'master']);
            queryClient.invalidateQueries(['contractMetadata']);
        }
    } catch {
        // ignore
    }
}

export function usePrefetchHints(queryClient: QueryClient, address?: string) {
    const hints = useHints(address);
    const mintlessHints = useMintlessHints(address);
    const { isTestnet } = useNetwork();

    useEffect(() => {
        if (!address) {
            return;
        }

        (async () => {
            // Invalidate jettons data if version is changed
            invalidateJettonsDataIfVersionChanged(queryClient);

            // Prefetch contract metadata and jetton master content
            await Promise.all(hints.map(async hint => {
                let result = queryClient.getQueryData<StoredContractMetadata>(Queries.ContractMetadata(hint));
                if (!result) {
                    result = await queryClient.fetchQuery({
                        queryKey: Queries.ContractMetadata(hint),
                        queryFn: contractMetadataQueryFn(isTestnet, hint),
                    });

                    if (result?.jettonWallet) {
                        queryClient.setQueryData(Queries.Account(hint).JettonWallet(), () => {
                            return {
                                balance: result!.jettonWallet!.balance,
                                master: result!.jettonWallet!.master,
                                owner: result!.jettonWallet!.owner,
                                address: hint
                            } as StoredJettonWallet
                        });
                    }
                }

                const masterAddress = result?.jettonWallet?.master;
                let masterContent = masterAddress
                    ? queryClient.getQueryData<JettonMasterState>(Queries.Jettons().MasterContent(masterAddress))
                    : undefined;

                if (masterAddress && !masterContent) {
                    let masterAddress = result!.jettonWallet!.master;
                    await queryClient.prefetchQuery({
                        queryKey: Queries.Jettons().MasterContent(masterAddress),
                        queryFn: jettonMasterContentQueryFn(masterAddress, isTestnet),
                    });
                    await queryClient.prefetchQuery({
                        queryKey: Queries.Jettons().Address(address).Wallet(masterAddress),
                        queryFn: jettonWalletAddressQueryFn(masterAddress, address, isTestnet),
                    });
                }

                masterContent = queryClient.getQueryData<JettonMasterState>(Queries.Jettons().MasterContent(hint));

                if (result?.jettonMaster && !masterContent) {
                    await queryClient.prefetchQuery({
                        queryKey: Queries.Jettons().MasterContent(hint),
                        queryFn: jettonMasterContentQueryFn(hint, isTestnet),
                    });
                    await queryClient.prefetchQuery({
                        queryKey: Queries.Jettons().Address(address).Wallet(hint),
                        queryFn: jettonWalletAddressQueryFn(hint, address, isTestnet),
                    });
                }
            }));

            // Prefetch mintless jettons
            await Promise.all(mintlessHints.map(async hint => {
                let result = queryClient.getQueryData<JettonMasterState>(Queries.Jettons().MasterContent(hint.jetton.address));
                if (!result) {
                    await queryClient.prefetchQuery({
                        queryKey: Queries.Jettons().MasterContent(hint.jetton.address),
                        queryFn: jettonMasterContentQueryFn(hint.jetton.address, isTestnet),
                    });
                    await queryClient.prefetchQuery({
                        queryKey: Queries.Jettons().Address(address).Wallet(hint.walletAddress.address),
                        queryFn: jettonWalletAddressQueryFn(hint.walletAddress.address, address, isTestnet)
                    });
                }
            }));
        })().catch((e) => {
            console.warn(e);
        });
    }, [address, hints, mintlessHints]);
}