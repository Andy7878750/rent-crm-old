import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { listMeters, loadMonthInput, readAccountList } from '@/lib/data';
import { lineKey, meterUnits, sourceUsage } from '@/lib/calc/engine';
import { monthFields } from '@/lib/calc/lines';
import type { ReceiptConfig } from '@/lib/calc/types';
import { defaultMonth, isMonth, monthLabel } from '@/lib/month';
import { CATEGORIES, category } from '@/lib/receipts';
import { fromLegacy, newConfig, UNITS } from '@/lib/receipt-config';
import { ReceiptForm, type MonthData, type OtherReceipt } from './receipt-form';
import type { ReceiptDraft } from './actions';

export const metadata = { title: 'Квитанция' };

export default async function ReceiptPage({ params, searchParams }: PageProps<'/objects/[id]/receipt'>) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const month = isMonth(sp.m) ? sp.m : defaultMonth();
  const [{ input, objects }, meters, saved] = await Promise.all([
    loadMonthInput(user.accountId, month), listMeters(user.accountId, id), readAccountList(user.accountId, 'suppliers'),
  ]);
  const obj = objects.find((o) => o.id === id);
  if (!obj) notFound();
  const tenants = obj.tenants.map((t) => ({ id: t.id, name: obj.isOwner ? 'Вы (собственник)' : t.name, share: Number(t.share) }));
  const services = input.services.filter((x) => x.objectId === obj.id);
  const sid = typeof sp.s === 'string' ? sp.s : null;
  const svc = sid ? services.find((x) => x.id === sid) : undefined;
  if (sid && !svc) notFound();

  // Другие квитанции объекта со счётчиками — для «суммы других счётчиков».
  const others: OtherReceipt[] = services.filter((x) => x.id !== svc?.id && meterUnits(x).length).map((x) => ({
    id: x.id, name: x.name, units: meterUnits(x),
    use: Object.fromEntries(UNITS.filter((u) => meterUnits(x).includes(u)).map((u) => [u,
      Object.fromEntries(tenants.map((t) => [t.id, sourceUsage(input, x.id, t.id, u) ?? null]))])),
  }));

  // Начальные значения: квитанция из строк, старая квитанция (раскладываем по строкам) или новый вид (?c=el).
  let init: ReceiptDraft, converted = false;
  const fresh = (c: string): ReceiptConfig => newConfig(c, tenants, []);
  if (svc) {
    let cfg = svc.config ?? null;
    if (!cfg) { cfg = fromLegacy(svc, tenants, month) ?? fresh(svc.category ?? ''); converted = true; }
    init = { category: svc.category ?? '', supplier: svc.supplier, name: svc.name, cfg };
  } else {
    const c = category(typeof sp.c === 'string' ? sp.c : CATEGORIES.find((x) => !services.some((y) => y.category === x.id))?.id ?? '');
    const cfg = fresh(c.id);
    const l = cfg.lines[0];
    if (l.q.src === 'sum') l.q.srcs = others.filter((o) => o.units.includes(l.unit)).map((o) => o.id);
    // Номера счётчиков объекта подставляем в строку счётчика.
    if (l.q.src === 'each' && c.resource) {
      l.meters = Object.fromEntries(meters.filter((m) => m.resource === c.resource && m.number && (m.tenantId ? tenants.some((t) => t.id === m.tenantId) : true))
        .map((m) => [m.tenantId ?? 'common', m.number]));
    }
    init = { category: c.id, supplier: c.supplier, name: c.name, cfg };
  }

  // Числа этого месяца для «Примера расчёта» при правке.
  const data: MonthData = { values: {}, readings: {} };
  if (svc) {
    for (const f of monthFields(init.cfg)) {
      data.values[f.key] = f.key === init.cfg.billKey ? input.bills[obj.id]?.[svc.id] : input.values?.[obj.id]?.[svc.id]?.[f.key];
    }
    for (const t of tenants) data.readings[t.id] = Object.fromEntries(init.cfg.lines.map((l) => [l.id, input.readings[t.id]?.[lineKey(svc.id, l.id)]]));
  }

  const suppliers = [...new Set([...saved, ...services.map((x) => x.supplier), ...CATEGORIES.map((c) => c.supplier).filter(Boolean)])];
  return (
    <ReceiptForm
      objectId={obj.id} objectName={obj.short} isOwner={obj.isOwner} month={month} monthText={monthLabel(month)}
      serviceId={svc?.id ?? null} init={init} suppliers={suppliers} tenants={tenants} others={others} data={data} converted={converted}
    />
  );
}
