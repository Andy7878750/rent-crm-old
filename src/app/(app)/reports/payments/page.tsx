import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db';
import { requireUser } from '@/lib/auth/session';
import { loadMonthInput } from '@/lib/data';
import { activeTariff } from '@/lib/calc/engine';
import { fmtMoney, sumMoney } from '@/lib/calc/format';
import { defaultMonth, isMonth } from '@/lib/month';
import { MonthNav } from '@/components/month-nav';
import { PayCell, type PayCellData } from './pay-cell';

export const metadata = { title: 'Оплаты поставщикам' };

const BILL_LOGICS = ['share', 'split', 'meterRest', 'whole'];

export default async function PaymentsPage({ searchParams }: PageProps<'/reports/payments'>) {
  const user = await requireUser();
  const sp = await searchParams;
  const month = isMonth(sp.m) ? sp.m : defaultMonth();
  const { input, objects } = await loadMonthInput(user.accountId, month);
  const [acc] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, user.accountId)).limit(1);
  const payCols = ((acc?.settings ?? {}) as { payCols?: Record<string, boolean> }).payCols ?? {};
  const pays = objects.length ? await db.select().from(schema.supplierPayments)
    .where(and(inArray(schema.supplierPayments.objectId, objects.map((o) => o.id)), eq(schema.supplierPayments.month, month))) : [];

  // Колонки — поставщики в порядке услуг.
  const suppliers: string[] = [];
  input.services.forEach((s) => { if (!suppliers.includes(s.supplier)) suppliers.push(s.supplier); });

  const colSum = suppliers.map(() => 0);
  let total = 0, paid = 0, unpaid = 0;
  const rows = objects.map((o) => {
    let rowSum = 0;
    const cells: PayCellData[] = suppliers.map((sup, ci) => {
      const svcs = input.services.filter((s) => s.supplier === sup && (!s.objectId || s.objectId === o.id));
      // Поставщик относится к объекту, если его тариф действует хотя бы для одного арендатора объекта (или «только арендодатель»).
      const auto = svcs.some((s) => !!s.config || s.kind === 'owner' || o.tenants.some((t) => activeTariff(s, t.id, month)));
      const manual = payCols[`${o.id}|${sup}`];
      const on = manual ?? auto;
      if (!on) return { objectId: o.id, supplier: sup, month, on: false, auto };
      // Связь со «Счетами на помещение»: услуга этого поставщика, где сумма вводится на объект.
      // У квитанции из строк — её главная сумма (billKey), если она есть.
      const linked = svcs.find((s) => (s.config ? !!s.config.billKey
        : s.kind === 'owner' || o.tenants.some((t) => BILL_LOGICS.includes(activeTariff(s, t.id, month)?.logic ?? ''))));
      const pay = pays.find((p) => p.objectId === o.id && p.supplier === sup);
      const amount = linked ? input.bills[o.id]?.[linked.id] : (pay?.amount != null ? Number(pay.amount) : undefined);
      if (amount !== undefined) { rowSum += amount; colSum[ci] += amount; total += amount; if (pay?.paidOn) paid += amount; }
      if (!pay?.paidOn) unpaid += 1;
      return { objectId: o.id, supplier: sup, month, on: true, auto, manual: manual === true && !auto, linkedServiceId: linked?.id ?? null, amount, paidOn: pay?.paidOn ?? null };
    });
    return { o, cells, rowSum };
  });

  const cols = `minmax(180px,1.4fr) repeat(${suppliers.length}, minmax(132px,1fr)) 110px`;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-bold">Оплаты поставщикам</h1>
        <MonthNav month={month} path="/reports/payments" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <div className="card px-4 py-3.5"><div className="text-[12px] text-muted">Начислено</div><div className="text-[22px] font-bold">{fmtMoney(total)} ₽</div></div>
        <div className="card px-4 py-3.5"><div className="text-[12px] text-muted">Оплачено</div><div className="text-[22px] font-bold text-ok">{fmtMoney(paid)} ₽</div></div>
        <div className="card px-4 py-3.5"><div className="text-[12px] text-muted">Осталось оплатить</div><div className="text-[22px] font-bold">{fmtMoney(total - paid)} ₽</div><div className="hint">не оплачено счетов: {unpaid}</div></div>
      </div>
      <p className="text-[13px] text-muted">Колонки — поставщики из квитанций объектов. Сумма здесь и в квитанции объекта — одно и то же число. Кружок — отметка «оплачено». Серая клетка — поставщик не привязан, «+» добавляет его.</p>
      {suppliers.length === 0 ? (
        <div className="card p-6 text-ink-2">Сначала добавьте квитанции на страницах объектов.</div>
      ) : (
        <div className="card overflow-x-auto">
          <div role="table" aria-label="Оплаты поставщикам" style={{ minWidth: 180 + suppliers.length * 140 + 150 }}>
            <div role="row" className="grid items-end gap-2 rounded-t-xl bg-[#f6f8fb] px-4 py-2.5 text-[12px] font-semibold text-muted" style={{ gridTemplateColumns: cols }}>
              <span role="columnheader">Объект</span>
              {suppliers.map((s) => <span key={s} role="columnheader" className="text-right">{s}</span>)}
              <span role="columnheader" className="text-right">Итого</span>
            </div>
            {rows.map(({ o, cells, rowSum }) => (
              <div key={o.id} role="row" className="grid items-start gap-2 border-t border-[#eef1f5] px-4 py-2.5" style={{ gridTemplateColumns: cols }}>
                <span role="rowheader" className="min-w-0"><b className="block truncate font-semibold">{o.short}</b>
                  <span className="hint">{o.isOwner || !o.tenants.length ? 'собственник' : o.tenants.map((t) => t.name).join(', ')}</span></span>
                {cells.map((c) => <PayCell key={c.supplier} c={c} />)}
                <span role="cell" className="self-center whitespace-nowrap text-right font-semibold">{rowSum ? fmtMoney(rowSum) : '—'}</span>
              </div>
            ))}
            <div role="row" className="grid gap-2 rounded-b-xl border-t-2 border-nav bg-[#f6f8fb] px-4 py-2.5 font-bold" style={{ gridTemplateColumns: cols }}>
              <span role="rowheader">Итого</span>
              {colSum.map((v, i) => <span key={i} role="cell" className="whitespace-nowrap text-right">{v ? fmtMoney(v) : '—'}</span>)}
              <span role="cell" className="whitespace-nowrap text-right">{fmtMoney(sumMoney(colSum))} ₽</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
