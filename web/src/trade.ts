import { api, esc, modal, toast, usd } from "./lib";

/** Manual paper order dialog. Goes through the same risk engine as the agent. */
export function openTrade(t: { cryptoId: number; symbol: string; name?: string; price: number; issuerName?: string | null }, side: "buy" | "sell" = "buy", onDone?: () => void) {
  modal(
    `<h2>${side === "buy" ? "Buy" : "Sell"} ${esc(t.symbol)} <span class="muted small">paper</span></h2>
     <p class="muted small">${esc(t.name ?? "")}${t.issuerName ? ` · ${esc(t.issuerName)}` : ""} · last ${usd(t.price)}</p>
     ${side === "buy"
       ? `<label class="field">Amount (USD)<input id="amt" type="number" min="1" step="100" value="1000" /></label>`
       : `<label class="field">Fraction of position to sell<select id="frac"><option value="1">100% (close)</option><option value="0.5">50%</option><option value="0.25">25%</option></select></label>`}
     <label class="field" style="margin-top:10px">Note (optional)<input id="why" maxlength="200" placeholder="why?" /></label>
     <p class="muted small">Simulated fill at the latest CMC price with 10 bps fee and size-based slippage. Risk limits apply.</p>
     <div class="row" style="justify-content:flex-end"><button id="cancel">Cancel</button><button class="primary" id="go">${side === "buy" ? "Place buy" : "Place sell"}</button></div>`,
    (root, close) => {
      root.querySelector("#cancel")!.addEventListener("click", close);
      root.querySelector("#go")!.addEventListener("click", async () => {
        const body: Record<string, unknown> = { cryptoId: t.cryptoId, side, reason: (root.querySelector("#why") as HTMLInputElement).value || undefined };
        if (side === "buy") body.usd = Number((root.querySelector("#amt") as HTMLInputElement).value);
        else body.fraction = Number((root.querySelector("#frac") as HTMLSelectElement).value);
        try {
          const o = await api("/api/orders", { method: "POST", json: body });
          if (o.status === "filled") toast(`${side === "buy" ? "Bought" : "Sold"} ${o.symbol}: ${usd(o.notional)} @ ${usd(o.price)}`);
          else toast(`Rejected: ${o.rejectReason}`, true);
          close();
          onDone?.();
        } catch (err) {
          toast((err as Error).message, true);
        }
      });
    },
  );
}
