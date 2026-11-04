import 'server-only';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { shiftMonth } from '@/lib/month';
import type { MonthInput, Reading, Service as CalcService, Tariff as CalcTariff } from '@/lib/calc/types';

const num = (v: string | null | undefined) => (v === null || v === undefined ? undefined : Number(v));

export type ObjectRow = typeof schema.objects.$inferSelect & { tenants: (typeof schema.tenants.$inferSelect)[] };

/** Объекты аккаунта с арендаторами (без архивных). */
export async function listObjects(accountId: string): Promise<ObjectRow[]> {
  const objs = await db.select().from(schema.objects)
    .where(and(eq(schema.objects.accountId, accountId), isNull(schema.objects.archivedAt)))
    .orderBy(asc(schema.objects.sort), asc(schema.objects.createdAt));
  if (!objs.length) return [];
  const tens = await db.select().from(schema.tenants)
    .where(and(inArray(schema.tenants.objectId, objs.map((o) => o.id)), isNull(schema.tenants.archivedAt)))
    .orderBy(asc(schema.tenants.sort), asc(schema.tenants.createdAt));
  return objs.map((o) => ({ ...o, tenants: tens.filter((t) => t.objectId === o.id) }));
}

export async function getObject(accountId: string, id: string): Promise<ObjectRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const all = await listObjects(accountId);
  return all.find((o) => o.id === id) ?? null;
}

/** Услуги аккаунта с тарифами — в формате модуля расчёта. */
export async function loadServices(accountId: string): Promise<CalcService[]> {
  const svcs = await db.select().from(schema.services).where(eq(schema.services.accountId, accountId))
    .orderBy(asc(schema.services.sort), asc(schema.services.createdAt));
  if (!svcs.length) return [];
  const trs = await db.select().from(schema.tariffs).where(inArray(schema.tariffs.serviceId, svcs.map((s) => s.id)));
  const links = trs.length ? await db.select().from(schema.tariffTenants).where(inArray(schema.tariffTenants.tariffId, trs.map((t) => t.id))) : [];
  return svcs.map((s) => ({
    id: s.id, objectId: s.objectId ?? undefined, category: s.category, supplier: s.supplier, name: s.name, unit: s.unit, kind: s.kind,
    config: s.config ?? undefined,
    tariffs: trs.filter((t) => t.serviceId === s.id).map((t): CalcTariff => ({
      logic: t.logic, price: num(t.price), price2: num(t.price2), norm: num(t.norm), normPrice: num(t.normPrice),
      extraName: t.extraName || undefined, sources: t.sources,
      who: t.whoAll ? 'all' : links.filter((l) => l.tariffId === t.id).map((l) => l.tenantId),
      from: t.validFrom,
    })),
  }));
}

/** Все данные месяца для расчёта: объекты, услуги, суммы счетов, показания. */
export async function loadMonthInput(accountId: string, month: string): Promise<{ input: MonthInput; objects: ObjectRow[] }> {
  const objects = await listObjects(accountId);
  const services = await loadServices(accountId);
  const objIds = objects.map((o) => o.id);
  const tenIds = objects.flatMap((o) => o.tenants.map((t) => t.id));
  const bills = objIds.length ? await db.select().from(schema.objectBills)
    .where(and(inArray(schema.objectBills.objectId, objIds), eq(schema.objectBills.month, month))) : [];
  const reads = tenIds.length ? await db.select().from(schema.readings)
    .where(and(inArray(schema.readings.tenantId, tenIds), eq(schema.readings.month, month))) : [];

  const vals = objIds.length ? await db.select().from(schema.receiptValues)
    .where(and(inArray(schema.receiptValues.objectId, objIds), eq(schema.receiptValues.month, month))) : [];

  const billMap: MonthInput['bills'] = {};
  for (const b of bills) (billMap[b.objectId] ??= {})[b.serviceId] = Number(b.amount);
  const valMap: NonNullable<MonthInput['values']> = {};
  for (const v of vals) ((valMap[v.objectId] ??= {})[v.serviceId] ??= {})[v.key] = Number(v.value);
  // Прошлый месяц: если «было» не внесено, берём «стало» прошлого месяца.
  const prevReads = tenIds.length ? await db.select().from(schema.readings)
    .where(and(inArray(schema.readings.tenantId, tenIds), eq(schema.readings.month, shiftMonth(month, -1)))) : [];
  const prevCur = new Map(prevReads.map((r) => [`${r.tenantId}|${r.serviceId}|${r.zone}`, num(r.cur)]));
  const readMap: MonthInput['readings'] = {};
  for (const r of prevReads) {
    const key = r.zone ? `${r.serviceId}:${r.zone}` : r.serviceId;
    if (r.cur !== null) (readMap[r.tenantId] ??= {})[key] = { prev: num(r.cur) };
  }
  for (const r of reads) {
    const key = r.zone ? `${r.serviceId}:${r.zone}` : r.serviceId;
    const v: Reading = { prev: num(r.prev) ?? prevCur.get(`${r.tenantId}|${r.serviceId}|${r.zone}`), cur: num(r.cur), usage: num(r.usage) };
    (readMap[r.tenantId] ??= {})[key] = v;
  }
  return {
    objects,
    input: {
      month,
      services,
      bills: billMap,
      values: valMap,
      readings: readMap,
      objects: objects.map((o) => ({
        id: o.id, name: o.short, owner: o.isOwner,
        tenants: o.tenants.map((t) => ({ id: t.id, name: t.name, share: Number(t.share) })),
      })),
    },
  };
}

export type MeterRow = typeof schema.meters.$inferSelect;

/** Счётчики объектов аккаунта. */
export async function listMeters(accountId: string, objectId?: string): Promise<MeterRow[]> {
  const objs = (await listObjects(accountId)).map((o) => o.id);
  const ids = objectId ? objs.filter((id) => id === objectId) : objs;
  if (!ids.length) return [];
  return db.select().from(schema.meters).where(inArray(schema.meters.objectId, ids))
    .orderBy(asc(schema.meters.sort), asc(schema.meters.createdAt));
}

/** Суммы квитанций объекта за месяц: { serviceId: руб. } — для «ждём квитанцию» (была в прошлом месяце). */
export async function objectBillsOf(objectId: string, month: string): Promise<Record<string, number>> {
  const rows = await db.select().from(schema.objectBills)
    .where(and(eq(schema.objectBills.objectId, objectId), eq(schema.objectBills.month, month)));
  return Object.fromEntries(rows.map((r) => [r.serviceId, Number(r.amount)]));
}

export type InvoiceSnapshot = {
  tenantName: string; objectName: string; share: number;
  lines: import('@/lib/calc/types').BillLine[];
  meters: import('@/lib/calc/types').MeterUse[];
};

/** Выставленные счета аккаунта (по месяцу или все), новые сверху. */
export async function listInvoices(accountId: string, month?: string) {
  const where = month
    ? and(eq(schema.invoices.accountId, accountId), eq(schema.invoices.month, month))
    : eq(schema.invoices.accountId, accountId);
  return db.select({
    id: schema.invoices.id, tenantId: schema.invoices.tenantId, month: schema.invoices.month, number: schema.invoices.number,
    issuedOn: schema.invoices.issuedOn, total: schema.invoices.total, paidOn: schema.invoices.paidOn, lines: schema.invoices.lines,
    tenantName: schema.tenants.name, objectName: schema.objects.short, objectId: schema.objects.id,
  }).from(schema.invoices)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.invoices.tenantId))
    .innerJoin(schema.objects, eq(schema.objects.id, schema.tenants.objectId))
    .where(where)
    .orderBy(desc(schema.invoices.month), desc(schema.invoices.createdAt));
}

/** Свои типы объектов аккаунта (пункты списка «Тип»). */
export async function readObjectTypes(accountId: string): Promise<string[]> {
  const [acc] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const t = (acc?.settings as { objectTypes?: unknown } | undefined)?.objectTypes;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
}

export async function writeObjectTypes(accountId: string, types: string[]) {
  const [acc] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  await db.update(schema.accounts).set({ settings: { ...(acc?.settings ?? {}), objectTypes: types } }).where(eq(schema.accounts.id, accountId));
}

/** Все подсказки «?» (без содержимого файлов): заданные администратором, иначе текст по умолчанию. */
export async function loadHelpTips(): Promise<Record<string, import('@/lib/help').HelpTip>> {
  const { HELP } = await import('@/lib/help');
  const rows = await db.select({ key: schema.helpTips.key, text: schema.helpTips.text, enabled: schema.helpTips.enabled, fileName: schema.helpTips.fileName, fileType: schema.helpTips.fileType })
    .from(schema.helpTips);
  const out: Record<string, import('@/lib/help').HelpTip> = {};
  for (const h of HELP) {
    const r = rows.find((x) => x.key === h.key);
    out[h.key] = { label: h.label, text: r ? r.text : h.text, on: r?.enabled ?? h.on, file: r?.fileName ? { name: r.fileName, type: r.fileType ?? '' } : null };
  }
  return out;
}

/** Свой список значений аккаунта в настройках (например, поставщики для выпадающего списка). */
export async function readAccountList(accountId: string, key: 'suppliers'): Promise<string[]> {
  const [acc] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const t = (acc?.settings as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
}

export async function writeAccountList(accountId: string, key: 'suppliers', list: string[]) {
  const [acc] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  await db.update(schema.accounts).set({ settings: { ...(acc?.settings ?? {}), [key]: list } }).where(eq(schema.accounts.id, accountId));
}
