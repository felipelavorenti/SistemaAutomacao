import type { JsonValue } from './types.js';

/**
 * Converte os campos do nó Agendamento no que a fila usa: uma expressão cron (com
 * segundos), um intervalo em milissegundos ou uma data e hora única.
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export type ScheduleRepeat =
  | { kind: 'cron'; pattern: string; tz: string }
  | { kind: 'every'; every: number }
  | { kind: 'once'; at: number };

export class ScheduleError extends Error {}

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000 };

/** "8:30", "08:30:15" → [hora, minuto, segundo]. */
export function parseTime(raw: JsonValue | undefined): [number, number, number] {
  const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(raw ?? ''));
  const parts = match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
  if (!parts || parts[0]! > 23 || parts[1]! > 59 || parts[2]! > 59) {
    throw new ScheduleError('Horário inválido; use hh:mm:ss, como 08:30:00');
  }
  return parts as [number, number, number];
}

/** "2026-10-04T14:30:00" no fuso informado → milissegundos desde 1970. */
export function parseLocalDateTime(raw: JsonValue | undefined, timezone: string): number {
  const match = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(raw ?? ''));
  if (!match) throw new ScheduleError('Data e hora inválidas; use aaaa-mm-dd hh:mm:ss');
  const [y, mo, d, h, mi, s] = match.slice(1).map((v) => Number(v ?? 0)) as number[];
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo! - 1 || check.getUTCDate() !== d! || h! > 23 || mi! > 59 || s! > 59) {
    throw new ScheduleError('Data e hora inválidas; use aaaa-mm-dd hh:mm:ss');
  }
  // O fuso pode mudar o deslocamento perto da data (horário de verão); duas passadas acertam.
  let at = asUtc - offsetMs(asUtc, timezone);
  at = asUtc - offsetMs(at, timezone);
  return at;
}

/** Quanto o fuso está à frente do UTC naquele instante. */
function offsetMs(at: number, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
  } catch {
    throw new ScheduleError(`Fuso horário desconhecido: ${timezone}`);
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(at / 1000) * 1000;
}

export function scheduleRepeat(params: Record<string, JsonValue>): ScheduleRepeat {
  const mode = String(params.mode ?? 'interval');
  const tz = String(params.timezone || DEFAULT_TIMEZONE);
  const time = () => {
    const [h, m, s] = parseTime(params.time ?? '08:00:00');
    return `${s} ${m} ${h}`;
  };
  // Testa o fuso já aqui, para o erro aparecer ao salvar e não só ao rodar.
  if (mode !== 'interval') offsetMs(Date.now(), tz);

  switch (mode) {
    case 'interval': {
      const value = Number(params.intervalMinutes ?? 60);
      const unit = String(params.intervalUnit || 'minutes');
      if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) throw new ScheduleError('O intervalo precisa ser um número inteiro a partir de 1');
      if (!UNIT_MS[unit]) throw new ScheduleError(`Unidade de intervalo desconhecida: ${unit}`);
      return { kind: 'every', every: value * UNIT_MS[unit]! };
    }
    case 'daily':
      return { kind: 'cron', pattern: `${time()} * * *`, tz };
    case 'weekly': {
      const raw = Array.isArray(params.weekdays) ? params.weekdays : String(params.weekdays ?? '').split(',');
      const days = [...new Set(raw.map((d) => String(d).trim()).filter((d) => /^[0-6]$/.test(d)))].sort();
      if (!days.length) throw new ScheduleError('Escolha pelo menos um dia da semana');
      return { kind: 'cron', pattern: `${time()} * * ${days.join(',')}`, tz };
    }
    case 'monthly': {
      const day = Number(params.dayOfMonth ?? 1);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new ScheduleError('O dia do mês vai de 1 a 31');
      return { kind: 'cron', pattern: `${time()} ${day} * *`, tz };
    }
    case 'once':
      return { kind: 'once', at: parseLocalDateTime(params.dateTime, tz) };
    case 'cron': {
      const pattern = String(params.cron ?? '').trim();
      const fields = pattern.split(/\s+/).length;
      if (!pattern || (fields !== 5 && fields !== 6)) throw new ScheduleError('A expressão cron precisa de 5 campos (ou 6, com os segundos no começo)');
      return { kind: 'cron', pattern, tz };
    }
    default:
      throw new ScheduleError(`Tipo de agendamento desconhecido: ${mode}`);
  }
}
