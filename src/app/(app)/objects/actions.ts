'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { requireUser } from '@/lib/auth/session';
import { readObjectTypes, writeObjectTypes } from '@/lib/data';
import { monthFields } from '@/lib/calc/lines';
import { isMonth } from '@/lib/month';

const OWNER_NAME = 'Собственник';

export type ObjectFormState = { errors?: Record<string, string> };

type TenantIn = { id?: string; name: string; share: string; phone: string; email: string; contract: string; contractEnd: string };

const toNum = (s: string) => {
  const n = Number(String(s).replace(/\s/g, '').replace(',', '.'));
  return String(s).trim() !== '' && Number.isFinite(n) ? n : null;
};

/** Объект принадлежит аккаунту пользователя? Каждое действие проверяет это само. */
async function ownObject(accountId: string, objectId: string) {
  const [o] = await db.select({ id: schema.objects.id }).from(schema.objects)
    .where(and(eq(schema.objects.id, objectId), eq(schema.objects.accountId, accountId))).limit(1);
  return !!o;
}

async function ownService(accountId: string, serviceId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(serviceId)) return false;
  const [x] = await db.select({ id: schema.services.id }).from(schema.services)
    .where(and(eq(schema.services.id, serviceId), eq(schema.services.accountId, accountId))).limit(1);
  return !!x;
}

export async function saveObject(objectId: string | null, _prev: ObjectFormState, fd: FormData): Promise<ObjectFormState> {
  const user = await requireUser();
  const g = (k: string) => String(fd.get(k) ?? '').trim();
  const isOwner = fd.get('owner') === '1';
  let tenantsIn: TenantIn[] = [];
  try { tenantsIn = JSON.parse(String(fd.get('tenants') ?? '[]')); } catch { /* пусто */ }
  tenantsIn = tenantsIn.filter((t) => Object.entries(t).some(([k, v]) => k !== 'id' && String(v ?? '').trim()));

  const errors: Record<string, string> = {};
  if (!g('short')) errors.short = 'Введите короткое название';
  if (!isOwner) {
    tenantsIn.forEach((t, i) => {
      if (!t.name.trim()) errors[`t${i}.name`] = 'Введите имя';
      const s = toNum(t.share);
      if (s === null || s <= 0 || s > 100) errors[`t${i}.share`] = 'Доля от 0 до 100';
    });
    const sum = tenantsIn.reduce((a, t) => a + (toNum(t.share) ?? 0), 0);
    if (sum > 100.001) errors.shares = `Сумма долей ${String(Math.round(sum * 100) / 100).replace('.', ',')}% — больше 100%`;
  }
  if (Object.keys(errors).length) return { errors };
  if (objectId && !(await ownObject(user.accountId, objectId))) return { errors: { form: 'Объект не найден' } };

  const values = {
    type: (['nonres', 'flat', 'other'].includes(g('type')) ? g('type') : 'nonres') as 'nonres' | 'flat' | 'other',
    typeLabel: g('type') === 'other' ? g('typeLabel').slice(0, 40) : '',
    short: g('short'), address: g('address'), floor: g('floor'), ukName: g('ukName'), ukPhone: g('ukPhone'), ukEmail: g('ukEmail').slice(0, 120),
    cabinetUrl: g('cabinetUrl'), cabinetLogin: g('cabinetLogin'), cabinetHint: g('cabinetHint'), isOwner,
  };

  const id = await db.transaction(async (tx) => {
    let oid = objectId;
    const wasOwner = oid ? (await tx.select({ o: schema.objects.isOwner }).from(schema.objects).where(eq(schema.objects.id, oid)).limit(1))[0]?.o === true : false;
    if (oid) await tx.update(schema.objects).set(values).where(eq(schema.objects.id, oid));
    else oid = (await tx.insert(schema.objects).values({ ...values, accountId: user.accountId }).returning({ id: schema.objects.id }))[0].id;

    const existing = await tx.select({ id: schema.tenants.id }).from(schema.tenants)
      .where(and(eq(schema.tenants.objectId, oid), isNull(schema.tenants.archivedAt)));
    // Собственник работает как арендатор с долей 100%: те же услуги, ввод данных, расчёт и отчёт.
    if (isOwner) {
      const self = wasOwner ? existing[0] : undefined;
      const others = existing.filter((e) => e.id !== self?.id).map((e) => e.id);
      if (others.length) await tx.update(schema.tenants).set({ archivedAt: new Date() }).where(inArray(schema.tenants.id, others));
      if (!self) await tx.insert(schema.tenants).values({ objectId: oid, name: OWNER_NAME, share: '100', sort: 0 });
      return oid;
    }
    const keep = tenantsIn;
    const keptIds = new Set(keep.map((t) => t.id).filter(Boolean) as string[]);
    // Удалённые арендаторы уходят в архив: история и выставленные счета сохраняются.
    const gone = existing.map((e) => e.id).filter((x) => !keptIds.has(x));
    if (gone.length) await tx.update(schema.tenants).set({ archivedAt: new Date() }).where(inArray(schema.tenants.id, gone));
    for (const [i, t] of keep.entries()) {
      const row = {
        name: t.name.trim(), share: String(toNum(t.share)), phone: t.phone.trim(), email: t.email.trim(),
        contract: t.contract.trim(), contractEnd: t.contractEnd || null, sort: i,
      };
      if (t.id && existing.some((e) => e.id === t.id)) await tx.update(schema.tenants).set(row).where(eq(schema.tenants.id, t.id));
      else await tx.insert(schema.tenants).values({ ...row, objectId: oid });
    }
    return oid;
  });
  // Новый свой тип запоминаем в списке аккаунта.
  if (values.typeLabel) {
    const types = await readObjectTypes(user.accountId);
    if (!types.includes(values.typeLabel)) await writeObjectTypes(user.accountId, [...types, values.typeLabel]);
  }
  revalidatePath('/', 'layout');
  redirect(`/objects/${id}`);
}

/** Добавить свой тип в список сразу, не дожидаясь сохранения объекта. */
export async function addObjectType(label: string) {
  const user = await requireUser();
  const t = String(label ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!t) return;
  const types = await readObjectTypes(user.accountId);
  if (!types.some((x) => x.toLowerCase() === t.toLowerCase())) await writeObjectTypes(user.accountId, [...types, t]);
}

/** Убрать свой тип из списка. Объекты с этим типом его сохраняют. */
export async function removeObjectType(label: string) {
  const user = await requireUser();
  const types = await readObjectTypes(user.accountId);
  if (types.includes(label)) await writeObjectTypes(user.accountId, types.filter((t) => t !== label));
}

export async function archiveObject(objectId: string) {
  const user = await requireUser();
  if (!(await ownObject(user.accountId, objectId))) return;
  await db.update(schema.objects).set({ archivedAt: new Date() }).where(eq(schema.objects.id, objectId));
  revalidatePath('/', 'layout');
  redirect('/objects');
}

/** Сумма счёта поставщика на помещение за месяц. Пустое значение — удалить. */
export async function saveBill(objectId: string, serviceId: string, month: string, value: string) {
  const user = await requireUser();
  if (!isMonth(month) || !(await ownObject(user.accountId, objectId)) || !(await ownService(user.accountId, serviceId))) return { ok: false };
  const n = toNum(value);
  const key = and(eq(schema.objectBills.objectId, objectId), eq(schema.objectBills.serviceId, serviceId), eq(schema.objectBills.month, month));
  if (n === null) await db.delete(schema.objectBills).where(key);
  else await db.insert(schema.objectBills).values({ objectId, serviceId, month, amount: n.toFixed(2) })
    .onConflictDoUpdate({ target: [schema.objectBills.objectId, schema.objectBills.serviceId, schema.objectBills.month], set: { amount: n.toFixed(2) } });
  revalidatePath(`/objects/${objectId}`);
  return { ok: true };
}

/** Квитанция из строк аккаунта на этом объекте (с настройкой). */
async function ownReceipt(accountId: string, objectId: string, serviceId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(serviceId) || !/^[0-9a-f-]{36}$/i.test(objectId)) return null;
  const [x] = await db.select({ config: schema.services.config }).from(schema.services)
    .where(and(eq(schema.services.id, serviceId), eq(schema.services.accountId, accountId), eq(schema.services.objectId, objectId))).limit(1);
  return x?.config ? x.config : null;
}

/** Месячное значение квитанции из строк (сумма, объём, тариф месяца, общий счётчик). Главная сумма — в счетах на помещение. */
export async function saveReceiptValue(objectId: string, serviceId: string, month: string, key: string, value: string) {
  const user = await requireUser();
  const cfg = isMonth(month) ? await ownReceipt(user.accountId, objectId, serviceId) : null;
  if (!cfg) return { ok: false };
  if (!monthFields(cfg).some((f) => f.key === key)) return { ok: false };
  if (key === cfg.billKey) return saveBill(objectId, serviceId, month, value);
  const n = toNum(value);
  const where = and(eq(schema.receiptValues.objectId, objectId), eq(schema.receiptValues.serviceId, serviceId),
    eq(schema.receiptValues.month, month), eq(schema.receiptValues.key, key));
  if (n === null) await db.delete(schema.receiptValues).where(where);
  else await db.insert(schema.receiptValues).values({ objectId, serviceId, month, key, value: String(n) })
    .onConflictDoUpdate({ target: [schema.receiptValues.objectId, schema.receiptValues.serviceId, schema.receiptValues.month, schema.receiptValues.key], set: { value: String(n) } });
  revalidatePath(`/objects/${objectId}`);
  return { ok: true };
}

/** Постоянное значение строки из рамки (✎): сумма или объём, тариф, норма; и коэффициент квитанции. */
export async function saveReceiptConst(objectId: string, serviceId: string, lineId: string, field: 'qv' | 'tset' | 'k' | 'coef', value: string) {
  const user = await requireUser();
  const cfg = await ownReceipt(user.accountId, objectId, serviceId);
  if (!cfg) return { ok: false };
  const n = toNum(value);
  if (field === 'coef') cfg.coef = n !== null && n > 0 ? n : 1;
  else {
    const l = cfg.lines.find((x) => x.id === lineId);
    if (!l || (n !== null && n < 0)) return { ok: false };
    const v = n ?? undefined;
    if (field === 'qv') l.q.v = v;
    if (field === 'tset') l.t.p = v;
    if (field === 'k') l.q.k = v;
  }
  await db.update(schema.services).set({ config: cfg }).where(eq(schema.services.id, serviceId));
  revalidatePath(`/objects/${objectId}`);
  return { ok: true };
}

/** Показание: field = 'prev' | 'cur' | 'usage'. */
export async function saveReading(tenantId: string, serviceId: string, zone: string, month: string, field: 'prev' | 'cur' | 'usage', value: string) {
  const user = await requireUser();
  const [t] = await db.select({ objectId: schema.tenants.objectId }).from(schema.tenants)
    .innerJoin(schema.objects, eq(schema.objects.id, schema.tenants.objectId))
    .where(and(eq(schema.tenants.id, tenantId), eq(schema.objects.accountId, user.accountId))).limit(1);
  if (!t || !isMonth(month) || !(await ownService(user.accountId, serviceId)) || !/^(|day|night|L\d{1,3})$/.test(zone) || !['prev', 'cur', 'usage'].includes(field)) return { ok: false };
  const n = toNum(value);
  const v = n === null ? null : String(n);
  await db.insert(schema.readings).values({ tenantId, serviceId, zone, month, [field]: v })
    .onConflictDoUpdate({ target: [schema.readings.tenantId, schema.readings.serviceId, schema.readings.zone, schema.readings.month], set: { [field]: v } });
  revalidatePath(`/objects/${t.objectId}`);
  return { ok: true };
}
