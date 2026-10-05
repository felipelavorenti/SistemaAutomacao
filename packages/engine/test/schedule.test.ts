import { describe, expect, it } from 'vitest';
import { parseLocalDateTime, parseTime, scheduleRepeat } from '../src/schedule.js';
import { validateWorkflow } from '../src/validate.js';
import type { WorkflowDefinition } from '../src/types.js';

describe('Agendamento', () => {
  it('converte as opções prontas em cron com segundos', () => {
    expect(scheduleRepeat({ mode: 'daily', time: '08:30:15' })).toEqual({ kind: 'cron', pattern: '15 30 8 * * *', tz: 'America/Sao_Paulo' });
    expect(scheduleRepeat({ mode: 'weekly', weekdays: ['5', '1', '3'], time: '18:00:00', timezone: 'UTC' })).toEqual({
      kind: 'cron',
      pattern: '0 0 18 * * 1,3,5',
      tz: 'UTC',
    });
    expect(scheduleRepeat({ mode: 'monthly', dayOfMonth: 10, time: '7:05' })).toEqual({ kind: 'cron', pattern: '0 5 7 10 * *', tz: 'America/Sao_Paulo' });
    expect(scheduleRepeat({ mode: 'cron', cron: '*/30 * * * * *' })).toMatchObject({ kind: 'cron', pattern: '*/30 * * * * *' });
  });

  it('aceita intervalo em segundos, minutos e horas, e o fluxo antigo sem unidade', () => {
    expect(scheduleRepeat({ mode: 'interval', intervalMinutes: 30, intervalUnit: 'seconds' })).toEqual({ kind: 'every', every: 30_000 });
    expect(scheduleRepeat({ mode: 'interval', intervalMinutes: 15 })).toEqual({ kind: 'every', every: 900_000 });
    expect(scheduleRepeat({ mode: 'interval', intervalMinutes: 2, intervalUnit: 'hours' })).toEqual({ kind: 'every', every: 7_200_000 });
    expect(scheduleRepeat({})).toEqual({ kind: 'every', every: 3_600_000 });
  });

  it('converte a execução única no fuso escolhido', () => {
    expect(scheduleRepeat({ mode: 'once', dateTime: '2026-10-04T14:30:00' })).toEqual({ kind: 'once', at: Date.parse('2026-10-04T17:30:00Z') });
    expect(parseLocalDateTime('2026-07-01T09:00:00', 'Europe/Lisbon')).toBe(Date.parse('2026-07-01T08:00:00Z'));
    expect(parseLocalDateTime('2026-01-01 09:00', 'UTC')).toBe(Date.parse('2026-01-01T09:00:00Z'));
  });

  it('aceita milissegundos na execução única', () => {
    expect(scheduleRepeat({ mode: 'once', dateTime: '2026-10-04T14:30:00.250' })).toEqual({ kind: 'once', at: Date.parse('2026-10-04T17:30:00.250Z') });
    expect(parseLocalDateTime('2026-01-01T09:00:05.5', 'UTC')).toBe(Date.parse('2026-01-01T09:00:05.500Z'));
    expect(parseLocalDateTime('2026-01-01 09:00:05,007', 'UTC')).toBe(Date.parse('2026-01-01T09:00:05.007Z'));
    expect(() => parseLocalDateTime('2026-01-01T09:00:05.1234', 'UTC')).toThrow('Data e hora inválidas');
    expect(() => parseLocalDateTime('2026-01-01T09:00.500', 'UTC')).toThrow('Data e hora inválidas');
  });

  it('recusa valores errados com mensagem clara', () => {
    expect(() => parseTime('25:00')).toThrow('Horário inválido');
    expect(() => scheduleRepeat({ mode: 'weekly', weekdays: [] })).toThrow('pelo menos um dia');
    expect(() => scheduleRepeat({ mode: 'monthly', dayOfMonth: 32 })).toThrow('1 a 31');
    expect(() => scheduleRepeat({ mode: 'interval', intervalMinutes: 0 })).toThrow('a partir de 1');
    expect(() => scheduleRepeat({ mode: 'once', dateTime: '2026-02-30T10:00:00' })).toThrow('Data e hora inválidas');
    expect(() => scheduleRepeat({ mode: 'daily', timezone: 'Lua/Base' })).toThrow('Fuso horário desconhecido');
    expect(() => scheduleRepeat({ mode: 'cron', cron: '0 8 * *' })).toThrow('5 campos');
  });

  it('aponta o problema no fluxo e não repete o aviso de campo obrigatório', () => {
    const wf = (parameters: WorkflowDefinition['nodes'][number]['parameters']): WorkflowDefinition => ({
      nodes: [{ id: 's', name: 'Agendamento', type: 'scheduleTrigger', position: { x: 0, y: 0 }, parameters }],
      connections: [],
    });
    expect(validateWorkflow(wf({ mode: 'daily', time: '08:00:00' }))).toEqual([]);
    expect(validateWorkflow(wf({ mode: 'daily', time: '8h' })).map((i) => i.message)).toEqual(['"Agendamento": Horário inválido; use hh:mm:ss, como 08:30:00']);
    expect(validateWorkflow(wf({ mode: 'once', dateTime: '' })).map((i) => i.message)).toEqual(['"Agendamento": o campo Data e hora é obrigatório']);
  });
});
