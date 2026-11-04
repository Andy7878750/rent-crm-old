'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { requireUser } from '@/lib/auth/session';
import { isMonth } from '@/lib/month';
import { readAccountList, writeAccountList } from '@/lib/data';
import { category } from '@/lib/receipts';
import { kindOfConfig, sanitizeConfig } from '@/lib/receipt-config';
import type { ReceiptConfig } from '@/lib/calc/types';

/** Что приходит из окна квитанции. */
export type ReceiptDraft = { category: string; supplier: string; name: string; cfg: ReceiptConfig };
export type ReceiptState = { errors?: Record<string, string> };

/** Объект аккаунта с арендаторами (без архивных) и квитанциями. Каждое действие проверяет принадлежность само. */
async function ownObject(accountId: string, objectId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) return null;
  const [o] = await db.select().from(schema.objects)
    .where(and(eq(schema.objects.id, objectId), eq(schema.objects.accountId, accountId))).limit(1);
  if (!o) return null;
  const tenants = await db.select({ id: schema.tenants.id }).from(schema.tenants)
    .where(and(eq(schema.tenants.objectId, objectId), isNull(schema.tenants.archivedAt)));
  const services = await db.select({ id: schema.services.id }).from(schema.services).where(eq(schema.services.objectId, objectId));
  return { o, tenants: tenants.map((t) => t.id), services: new Set(services.map((s) => s.id)) };
}

/**
 * Сохранить квитанцию из строк. Месячные суммы и показания вписываются на странице объекта, здесь — только настройка.
 * Старая квитанция (по тарифам) при сохранении переходит на строки: ключи хранения те же, данные месяцев остаются.
 */
export async function saveReceipt(objectId: string, serviceId: string | null, month: string, _prev: ReceiptState, fd: FormData): Promise<ReceiptState> {
  const user = await requireUser();
  let d: ReceiptDraft;
  try { d = JSON.parse(String(fd.get('data') ?? '')); } catch { return { errors: { form: 'Не удалось прочитать форму' } }; }
  const own = await ownObject(user.accountId, objectId);
  if (!own || !isMonth(month)) return { errors: { form: 'Объект не найден' } };
  if (serviceId && !own.services.has(serviceId)) return { errors: { form: 'Квитанция не найдена' } };

  const cat = typeof d.category === 'string' ? category(d.category) : category('');
  const name = String(d.name ?? '').trim().slice(0, 60) || (cat.id ? cat.name : '');
  if (!name) return { errors: { name: 'Назовите квитанцию' } };
  const cfg = sanitizeConfig(d.cfg, own.tenants, [...own.services].filter((s) => s !== serviceId));
  if (!cfg) return { errors: { form: 'Не удалось прочитать строки квитанции' } };

  const values = {
    category: cat.id, supplier: String(d.supplier ?? '').trim().slice(0, 80) || name, name,
    unit: cfg.lines[0].unit, kind: kindOfConfig(cfg, own.tenants), config: cfg,
  };
  let id = serviceId;
  if (id) await db.update(schema.services).set(values).where(eq(schema.services.id, id));
  else {
    const last = await db.select({ sort: schema.services.sort }).from(schema.services).where(eq(schema.services.objectId, objectId)).orderBy(asc(schema.services.sort));
    id = (await db.insert(schema.services).values({ ...values, accountId: user.accountId, objectId, sort: last.length ? last[last.length - 1].sort + 1 : 0 })
      .returning({ id: schema.services.id }))[0].id;
  }

  // Нового поставщика запоминаем для выпадающего списка.
  const sup = String(d.supplier ?? '').trim();
  const list = await readAccountList(user.accountId, 'suppliers');
  if (sup && !list.some((x) => x.toLowerCase() === sup.toLowerCase())) await writeAccountList(user.accountId, 'suppliers', [...list, sup]);

  revalidatePath('/', 'layout');
  redirect(`/objects/${objectId}?m=${month}#r-${id}`);
}

/** Удалить квитанцию со всеми месяцами (выставленные счета не меняются — в них снимок). */
export async function deleteReceipt(objectId: string, serviceId: string, month: string) {
  const user = await requireUser();
  const own = await ownObject(user.accountId, objectId);
  if (!own || !own.services.has(serviceId)) return;
  await db.delete(schema.services).where(eq(schema.services.id, serviceId));
  revalidatePath('/', 'layout');
  redirect(`/objects/${objectId}?m=${isMonth(month) ? month : ''}`);
}
