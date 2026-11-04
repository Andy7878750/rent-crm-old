/**
 * Типы модуля расчёта коммунальных платежей.
 * Модуль не зависит от базы данных и интерфейса: на входе данные месяца, на выходе — строки счёта.
 */

/** Вид счёта услуги (раздел 5 ТЗ). */
export type ServiceKind =
  | 'common' // Общий счёт: приходит на всё помещение и делится между арендаторами
  | 'indiv' // Индивидуальный: у арендатора свой счётчик или своя сумма
  | 'owner'; // Только арендодатель: арендаторы не видят

/** Логика расчёта тарифа (раздел 7 ТЗ). */
export type Logic =
  // Общий счёт
  | 'share' // Доля по квитанции: сумма квитанции × доля арендатора
  | 'split' // Делится по показаниям: сумма на объект ÷ расход всех × свой расход
  | 'meterRest' // Счётчики + остаток по долям
  | 'fixed' // Фиксированная сумма в месяц (и для индивидуального)
  | 'equal' // Поровну: сумма квитанции ÷ число платящих
  // Индивидуальный
  | 'meter' // По счётчику: расход × цена
  | 'dn' // День / ночь: день × цена 1 + ночь × цена 2
  | 'derived' // От других услуг: (расход выбранных услуг) × цена
  | 'norm' // С нормативом: расход × норматив × цена
  // Только арендодатель
  | 'whole'; // Вся сумма на арендодателе

export interface Tariff {
  logic: Logic;
  /** Основная цена (руб. за единицу или фиксированная сумма для 'fixed'). */
  price?: number;
  /** Цена ночной зоны для 'dn'. */
  price2?: number;
  /** Норматив (например, Гкал на м³) для 'norm' и 'meterRest'. */
  norm?: number;
  /** Цена единицы норматива для 'meterRest' (например, руб. за Гкал). */
  normPrice?: number;
  /** Название доп. начисления в 'meterRest', например «Подогрев ГВС». */
  extraName?: string;
  /** Услуги-источники расхода для 'derived' и 'norm'. */
  sources?: string[];
  /** Для кого: все арендаторы или список id арендаторов. */
  who: 'all' | string[];
  /** Действует с даты (включительно), формат YYYY-MM-DD. */
  from: string;
}

export interface Service {
  id: string;
  /** Объект, к которому привязана квитанция. Пусто — старая услуга аккаунта (действует по тарифу на любом объекте). */
  objectId?: string;
  /** Вид квитанции (электричество, вода…), см. src/lib/receipts.ts. */
  category?: string;
  supplier: string;
  name: string;
  unit: string;
  kind: ServiceKind;
  tariffs: Tariff[];
  /** Квитанция из строк (окно-конструктор). Есть — считается по строкам, тарифы не используются. */
  config?: ReceiptConfig;
}

/**
 * Откуда берётся количество строки квитанции:
 * const — вписано один раз; month — вписывается каждый месяц (общее); each — показания у каждого арендатора;
 * norm — норма × другая строка; sum — сумма счётчиков других квитанций.
 */
export type QtySrc = 'const' | 'month' | 'each' | 'norm' | 'sum';

/** Строка квитанции: количество × тариф (как строка бумажной квитанции). Единица «₽» — тарифа нет, количество и есть сумма. */
export interface ReceiptLine {
  /** Ключ хранения: зона показаний и префикс месячных значений. '' — первая строка. */
  id: string;
  sign: 1 | -1;
  name: string;
  unit: string;
  q: {
    src: QtySrc;
    /** Постоянный объём или сумма (const). */
    v?: number;
    /** Показания: «было → стало» или «сразу расход». */
    read?: 'diff' | 'direct';
    /** Норма на единицу строки ref (norm). */
    k?: number;
    ref?: string;
    /** Квитанции, чьи счётчики складываем (sum). */
    srcs?: string[];
  };
  /** Тариф: set — задан один раз; month — вписывается каждый месяц; sum — выходит из суммы квитанции ÷ объём. */
  t: { mode: 'set' | 'month' | 'sum'; p?: number; common?: boolean };
  /** Номера счётчиков: tenantId или 'common' → номер. */
  meters?: Record<string, string>;
}

export interface ReceiptPay {
  /** Как делим общее: по долям или поровну. */
  mode: 'shares' | 'equal';
  /** Пустующая доля объекта — на вас. */
  vacant: boolean;
  /** Остаток по квитанции (по квитанции больше, чем начислено): не считаем, по долям, поровну, на вас. */
  rest: 'none' | 'shares' | 'equal' | 'self';
  /** Остаток от количества по квитанции × тариф строки baseLine или от итога квитанции. */
  base: 'qty' | 'total';
  baseLine?: string;
  /** Платят сами: этим арендаторам квитанция в счёт не идёт. */
  off: string[];
}

export interface ReceiptConfig {
  lines: ReceiptLine[];
  pay: ReceiptPay;
  /** Коэффициент к начислению арендаторам (например, 1,06 — покрыть налог). */
  coef: number;
  /** Какое месячное значение хранится как сумма счёта на помещение (bills), например ':v' или 'total'. */
  billKey?: string;
}

export interface Tenant {
  id: string;
  name: string;
  /** Доля помещения в процентах, например 45. */
  share: number;
}

export interface PropertyObject {
  id: string;
  name: string;
  /** Объект собственника: арендаторов нет, расчёта нет. */
  owner?: boolean;
  tenants: Tenant[];
}

/** Показание счётчика за месяц. Для 'split' достаточно usage (расход за месяц). */
export interface Reading {
  prev?: number;
  cur?: number;
  usage?: number;
}

export interface MonthInput {
  /** Расчётный месяц, YYYY-MM. */
  month: string;
  objects: PropertyObject[];
  /** Услуги в порядке, заданном арендодателем (стрелки ↑ ↓). */
  services: Service[];
  /** Суммы счетов поставщиков на помещение: bills[objectId][serviceId] = руб. */
  bills: Record<string, Record<string, number | undefined>>;
  /**
   * Показания: readings[tenantId][key]. key = serviceId,
   * для счётчика день/ночь — `${serviceId}:day` и `${serviceId}:night`.
   */
  readings: Record<string, Record<string, Reading | undefined>>;
  /**
   * Месячные значения квитанций из строк: values[objectId][serviceId][key].
   * key — `${строка}:v` (сумма/объём), `:tp` (тариф месяца), `:money` (сумма для тарифа «из суммы»),
   * `:camt` / `:cprev` / `:ccur` (общий счётчик), а также 'qty' и 'total' (для остатка).
   * Значение с ключом config.billKey лежит в bills.
   */
  values?: Record<string, Record<string, Record<string, number | undefined>>>;
}

export type LineGroup = 'common' | 'indiv' | 'fixed';

export interface BillLine {
  serviceId: string;
  group: LineGroup;
  label: string;
  /** Как посчитано, например «4 м³ × 61,96 руб.». */
  formula: string;
  /** Пояснение (например, как получилась цена месяца). */
  note?: string;
  /** Сумма в рублях, округлённая до копеек; null — не хватает данных. */
  amount: number | null;
}

export interface MeterUse {
  serviceId: string;
  label: string;
  unit: string;
  prev?: number;
  cur?: number;
  /** Расход; null — показание не внесено. */
  usage: number | null;
  /** Новое показание меньше прошлого. */
  negative: boolean;
}

export interface TenantBill {
  tenantId: string;
  objectId: string;
  lines: BillLine[];
  meters: MeterUse[];
  /** Итог = сумма округлённых строк. */
  total: number;
  /** Чего не хватает для расчёта (пусто — готов к счёту). */
  missing: string[];
  /** Сколько услуг привязано к арендатору. */
  serviceCount: number;
}

export interface OwnerLine {
  serviceId: string;
  label: string;
  amount: number | null;
}

export interface MonthResult {
  tenants: Record<string, TenantBill>;
  /** Что остаётся на арендодателе по каждому объекту. */
  owner: Record<string, { lines: OwnerLine[]; total: number }>;
}
