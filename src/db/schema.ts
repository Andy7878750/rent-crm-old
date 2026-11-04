/**
 * Схема базы данных (PostgreSQL, Drizzle ORM).
 * Каждая строка данных принадлежит аккаунту арендодателя (account_id) — так данные разных арендодателей не смешиваются.
 */
import {
  boolean, char, customType, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Аккаунт арендодателя (подписчик сервиса). */
export const accounts = pgTable('accounts', {
  id: id(),
  name: text('name').notNull(),
  /** Реквизиты для отчёта: статус, ИНН, ОГРНИП, телефон, почта, банк, р/с, СБП, без НДС. */
  requisites: jsonb('requisites').$type<Record<string, unknown>>().notNull().default({}),
  /** Настройки: скрытые пункты меню и т. п. */
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

/** Пользователи: владелец аккаунта и до 3 сотрудников. */
export const users = pgTable('users', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  role: text('role', { enum: ['owner', 'staff'] }).notNull().default('owner'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

/** Сессии входа. В cookie лежит случайный токен, в базе — только его хеш. */
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/** Объект недвижимости. */
export const objects = pgTable('objects', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['nonres', 'flat', 'other'] }).notNull().default('nonres'),
  /** Свой вариант типа, когда выбрано «Другое» (склад, гараж…). */
  typeLabel: text('type_label').notNull().default(''),
  short: text('short').notNull(),
  address: text('address').notNull().default(''),
  floor: text('floor').notNull().default(''),
  ukName: text('uk_name').notNull().default(''),
  ukPhone: text('uk_phone').notNull().default(''),
  /** Почта УК / ТСЖ для связи (если нет личного кабинета). */
  ukEmail: text('uk_email').notNull().default(''),
  cabinetUrl: text('cabinet_url').notNull().default(''),
  cabinetLogin: text('cabinet_login').notNull().default(''),
  /** Только подсказка к паролю, сам пароль не храним. */
  cabinetHint: text('cabinet_hint').notNull().default(''),
  /** Объект собственника: арендаторов нет, счета оплачивает арендодатель. */
  isOwner: boolean('is_owner').notNull().default(false),
  /** Пример, созданный при регистрации. */
  isExample: boolean('is_example').notNull().default(false),
  sort: integer('sort').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('objects_account_idx').on(t.accountId)]);

/** Арендатор объекта. */
export const tenants = pgTable('tenants', {
  id: id(),
  objectId: uuid('object_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Доля помещения, %. */
  share: numeric('share', { precision: 5, scale: 2 }).notNull(),
  phone: text('phone').notNull().default(''),
  email: text('email').notNull().default(''),
  contract: text('contract').notNull().default(''),
  contractEnd: date('contract_end'),
  sort: integer('sort').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('tenants_object_idx').on(t.objectId)]);

/** Услуга = квитанция объекта: одна строка квитанции поставщика и как её делить (тарифы). */
export const services = pgTable('services', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** Объект квитанции. Пусто — старая услуга аккаунта (после миграции 0007 таких нет). */
  objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
  /** Вид квитанции: el, cw, hw, dr, heat, uk, trash… (src/lib/receipts.ts); '' — свой. */
  category: text('category').notNull().default(''),
  supplier: text('supplier').notNull(),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
  kind: text('kind', { enum: ['common', 'indiv', 'owner'] }).notNull(),
  /** Квитанция из строк (окно-конструктор): строки, кто платит, коэффициент. Пусто — считается по тарифам (старые квитанции). */
  config: jsonb('config').$type<import('../lib/calc/types').ReceiptConfig>(),
  /** Порядок в счёте (стрелки ↑ ↓). */
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('services_account_idx').on(t.accountId), index('services_object_idx').on(t.objectId)]);

/** Счётчик объекта: общий на объект или арендатора. Показания пока хранятся по арендатору и квитанции (readings). */
export const meters = pgTable('meters', {
  id: id(),
  objectId: uuid('object_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  /** Чей счётчик; пусто — общий на объект. */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  /** Ресурс: el, cw, hw, heat, gas, other. */
  resource: text('resource').notNull(),
  number: text('number').notNull().default(''),
  place: text('place').notNull().default(''),
  /** Двухтарифный (день / ночь). */
  dayNight: boolean('day_night').notNull().default(false),
  /** Поверка до. */
  verifyUntil: date('verify_until'),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('meters_object_idx').on(t.objectId)]);

/** Тариф услуги: логика, цены, для кого и с какой даты. */
export const tariffs = pgTable('tariffs', {
  id: id(),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  logic: text('logic', { enum: ['share', 'equal', 'split', 'meterRest', 'fixed', 'meter', 'dn', 'derived', 'norm', 'whole'] }).notNull(),
  price: numeric('price', { precision: 14, scale: 4 }),
  price2: numeric('price2', { precision: 14, scale: 4 }),
  norm: numeric('norm', { precision: 14, scale: 6 }),
  normPrice: numeric('norm_price', { precision: 14, scale: 4 }),
  extraName: text('extra_name').notNull().default(''),
  /** Услуги-источники расхода (для «от других услуг» и «с нормативом»). */
  sources: uuid('sources').array().notNull().default([]),
  /** true — для всех арендаторов, false — для списка в tariff_tenants. */
  whoAll: boolean('who_all').notNull().default(true),
  validFrom: date('valid_from').notNull(),
  createdAt: createdAt(),
}, (t) => [index('tariffs_service_idx').on(t.serviceId)]);

export const tariffTenants = pgTable('tariff_tenants', {
  tariffId: uuid('tariff_id').notNull().references(() => tariffs.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.tariffId, t.tenantId] })]);

/** Сумма счёта поставщика на помещение за месяц (то же число в «Вводе данных» и «Оплатах поставщикам»). */
export const objectBills = pgTable('object_bills', {
  objectId: uuid('object_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  month: char('month', { length: 7 }).notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
}, (t) => [primaryKey({ columns: [t.objectId, t.serviceId, t.month] })]);

/**
 * Месячные значения квитанции из строк, кроме главной суммы (она в object_bills) и показаний арендаторов (readings):
 * объём или сумма строки (`L2:v`), тариф месяца (`:tp`), общий счётчик (`:camt`, `:cprev`, `:ccur`), количество и итог для остатка.
 */
export const receiptValues = pgTable('receipt_values', {
  objectId: uuid('object_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  month: char('month', { length: 7 }).notNull(),
  key: text('key').notNull(),
  value: numeric('value', { precision: 14, scale: 4 }).notNull(),
}, (t) => [primaryKey({ columns: [t.objectId, t.serviceId, t.month, t.key] })]);

/** Показание счётчика арендатора за месяц. zone: '' | 'day' | 'night' | ключ строки квитанции (L2…). */
export const readings = pgTable('readings', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  zone: text('zone').notNull().default(''),
  month: char('month', { length: 7 }).notNull(),
  prev: numeric('prev', { precision: 14, scale: 3 }),
  cur: numeric('cur', { precision: 14, scale: 3 }),
  /** Расход за месяц напрямую (для «делится по показаниям»). */
  usage: numeric('usage', { precision: 14, scale: 3 }),
}, (t) => [primaryKey({ columns: [t.tenantId, t.serviceId, t.zone, t.month] })]);

/** Оплата поставщику: объект × поставщик × месяц. */
export const supplierPayments = pgTable('supplier_payments', {
  objectId: uuid('object_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
  supplier: text('supplier').notNull(),
  month: char('month', { length: 7 }).notNull(),
  /** Сумма, если её нет в «Счетах на помещение» (например, Водоканал по счётчикам). */
  amount: numeric('amount', { precision: 14, scale: 2 }),
  paidOn: date('paid_on'),
  /** Колонка добавлена (true) или убрана (false) вручную; null — по тарифам. */
  enabled: boolean('enabled'),
}, (t) => [primaryKey({ columns: [t.objectId, t.supplier, t.month] })]);

/** Выставленный арендатору счёт: снимок расчёта на момент выставления. */
export const invoices = pgTable('invoices', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  month: char('month', { length: 7 }).notNull(),
  number: text('number').notNull(),
  issuedOn: date('issued_on').notNull(),
  total: numeric('total', { precision: 14, scale: 2 }).notNull(),
  lines: jsonb('lines').notNull(),
  paidOn: date('paid_on'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('invoices_tenant_month_uq').on(t.tenantId, t.month)]);

/** Одноразовые ссылки из писем: сброс пароля и подтверждение почты. В базе — только хеш токена. */
export const emailTokens = pgTable('email_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['reset', 'verify'] }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * Подсказки «?» в интерфейсе — общие для всех пользователей сервиса, редактирует администратор сервиса.
 * key — место в интерфейсе (например, «service.supplier»), файл — пример (картинка или PDF).
 */
export const helpTips = pgTable('help_tips', {
  key: text('key').primaryKey(),
  text: text('text').notNull().default(''),
  /** Показывать «?» (null — как задано по умолчанию в src/lib/help.ts). */
  enabled: boolean('enabled'),
  fileName: text('file_name'),
  fileType: text('file_type'),
  fileData: bytea('file_data'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
