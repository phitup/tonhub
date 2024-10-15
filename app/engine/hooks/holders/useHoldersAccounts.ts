import { Address } from "@ton/core";
import { useNetwork } from "../network/useNetwork";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Queries } from "../../queries";
import { GeneralHoldersAccount, PrePaidHoldersCard, fetchAccountsList, fetchAccountsPublic } from "../../api/holders/fetchAccounts";
import { deleteHoldersToken, useHoldersAccountStatus } from "./useHoldersAccountStatus";
import { HoldersUserState } from "../../api/holders/fetchUserState";
import { updateProvisioningCredentials } from "../../holders/updateProvisioningCredentials";
import axios from "axios";

export type HoldersAccounts = {
    accounts: GeneralHoldersAccount[],
    type: 'public' | 'private',
    prepaidCards?: PrePaidHoldersCard[]
}

export function useHoldersAccounts(address: string | Address) {
    let { isTestnet } = useNetwork();
    let status = useHoldersAccountStatus(address).data;

    const addressString = useMemo(() => {
        if (address instanceof Address) {
            return address.toString({ testOnly: isTestnet });
        }
        return address;
    }, [address, isTestnet]);

    const token = (
        !!status &&
        status.state !== HoldersUserState.NoRef &&
        status.state !== HoldersUserState.NeedEnrollment
    ) ? status.token : null;

    let query = useQuery({
        queryKey: Queries.Holders(addressString).Cards(!!token ? 'private' : 'public'),
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        refetchInterval: 35000,
        staleTime: 35000,
        queryFn: async () => {
            try {
                let accounts;
                let prepaidCards: PrePaidHoldersCard[] | undefined;
                let type = 'public';

                if (token) {
                    const res = await fetchAccountsList(token, isTestnet);

                    if (!res) {
                        deleteHoldersToken(addressString);
                        throw new Error('Unauthorized');
                    }

                    type = 'private';
                    accounts = res?.accounts;
                    prepaidCards = res?.prepaidCards;

                    // fetch apple pay credentials and update provisioning credentials cache
                    await updateProvisioningCredentials(addressString, isTestnet);
                } else {
                    accounts = await fetchAccountsPublic(addressString, isTestnet);
                    type = 'public';
                }

                const filtered = accounts?.filter((a) => a.network === (isTestnet ? 'ton-testnet' : 'ton-mainnet'));

                const sorted = filtered?.sort((a, b) => {
                    if (a.cards.length > b.cards.length) return -1;
                    if (a.cards.length < b.cards.length) return 1;
                    return 0;
                });

                return { accounts: sorted, type, prepaidCards } as HoldersAccounts;
            } catch (error) {
                if (axios.isAxiosError(error) && error.response?.status === 401) {
                    deleteHoldersToken(addressString);
                    throw new Error('Unauthorized');
                } else {
                    throw error;
                }
            }
        }
    });

    return query;
}