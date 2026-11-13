import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";
import { LEAGUE } from "./chain";

declare const __NETWORK__: string;

/**
 * The viewer's NEAR wallet. Everything a person does on the site (post a task, back an agent,
 * issue a passport, accept an offer, dispute a score) is one call to the league contract signed
 * here; deposits go straight into the contract's escrow, the site never holds money.
 */
export interface Wallet {
  ready: boolean;
  account: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  /** Signs and sends one call to the league contract. Amounts are yoctoNEAR. */
  call: (method: string, args: Record<string, unknown>, deposit?: bigint, gasTera?: number) => Promise<unknown>;
}

const Ctx = createContext<Wallet>({
  ready: false,
  account: null,
  connect: () => {},
  disconnect: async () => {},
  call: async () => {
    throw new Error("wallet not ready");
  },
});

export const useWallet = () => useContext(Ctx);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [account, setAccount] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let sub: { unsubscribe: () => void } | null = null;
    (async () => {
      const network = (typeof __NETWORK__ === "string" ? __NETWORK__ : "testnet") as "testnet" | "mainnet";
      // The wallet code is large; it loads after the page, in its own chunk.
      const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupIntearWallet }, { setupHereWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/meteor-wallet"),
        import("@near-wallet-selector/intear-wallet"),
        import("@near-wallet-selector/here-wallet"),
      ]);
      // MyNearWallet no longer connects to apps (it points users to Meteor); HERE is mainnet only.
      const s = await setupWalletSelector({
        network,
        modules: network === "mainnet" ? [setupMeteorWallet(), setupIntearWallet(), setupHereWallet()] : [setupMeteorWallet(), setupIntearWallet()],
      });
      if (!live) return;
      const m = setupModal(s, { contractId: LEAGUE });
      setSelector(s);
      setModal(m);
      const pick = () => s.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
      setAccount(pick());
      sub = s.store.observable.subscribe(() => setAccount(pick()));
    })().catch((e) => console.warn("wallet selector failed to start", e));
    return () => {
      live = false;
      sub?.unsubscribe();
    };
  }, []);

  const call = useCallback(
    async (method: string, args: Record<string, unknown>, deposit = 0n, gasTera = 100) => {
      if (!selector || !account) throw new Error("connect a wallet first");
      const wallet = await selector.wallet();
      const { actionCreators } = await import("@near-js/transactions");
      return wallet.signAndSendTransaction({
        signerId: account,
        receiverId: LEAGUE,
        actions: [actionCreators.functionCall(method, args, BigInt(gasTera) * 10n ** 12n, deposit)],
      });
    },
    [selector, account],
  );

  const value = useMemo<Wallet>(
    () => ({
      ready: !!selector,
      account,
      connect: () => modal?.show(),
      disconnect: async () => {
        if (!selector) return;
        const w = await selector.wallet();
        await w.signOut();
      },
      call,
    }),
    [selector, modal, account, call],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Header control: connect, or the connected account with a sign-out menu. */
export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  if (!w.account)
    return (
      <button className="wallet-btn" onClick={w.connect} disabled={!w.ready}>
        {w.ready ? "Connect wallet" : "Wallet…"}
      </button>
    );
  return (
    <span className="wallet-wrap">
      <button className="wallet-btn" data-on onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <i className="dot" data-live /> {w.account.length > 22 ? w.account.slice(0, 10) + "…" + w.account.slice(-8) : w.account}
      </button>
      {open && (
        <span className="wallet-menu">
          <button
            onClick={() => {
              setOpen(false);
              void w.disconnect();
            }}
          >
            Disconnect
          </button>
        </span>
      )}
    </span>
  );
}

/** Wraps an action that needs a signed call: shows progress and the result or error inline. */
export function useTx() {
  const w = useWallet();
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const run = useCallback(
    async (label: string, method: string, args: Record<string, unknown>, deposit = 0n, gasTera = 100) => {
      if (!w.account) {
        w.connect();
        return null;
      }
      setState({ busy: true, error: null, done: null });
      try {
        const out = await w.call(method, args, deposit, gasTera);
        setState({ busy: false, error: null, done: label });
        return out;
      } catch (e) {
        setState({ busy: false, error: e instanceof Error ? e.message : String(e), done: null });
        return null;
      }
    },
    [w],
  );
  return { ...state, run, account: w.account, connect: w.connect };
}
