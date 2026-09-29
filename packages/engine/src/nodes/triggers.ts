import type { NodeType } from '../node-types.js';

export const manualTrigger: NodeType = {
  description: {
    type: 'manualTrigger',
    displayName: 'Gatilho manual',
    description: 'Inicia o fluxo pelo botão Executar, com um JSON de entrada opcional.',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    return [input.length ? input : [{ json: {} }]];
  },
};

export const scheduleTrigger: NodeType = {
  description: {
    type: 'scheduleTrigger',
    displayName: 'Agendamento',
    description: 'Inicia o fluxo em horários definidos, quando o fluxo está ativo.',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [
      {
        name: 'mode',
        displayName: 'Tipo de agendamento',
        type: 'options',
        default: 'interval',
        options: [
          { name: 'A cada intervalo', value: 'interval' },
          { name: 'Expressão cron', value: 'cron' },
        ],
      },
      {
        name: 'intervalMinutes',
        displayName: 'Intervalo (minutos)',
        type: 'number',
        default: 60,
        showWhen: { mode: ['interval'] },
      },
      {
        name: 'cron',
        displayName: 'Expressão cron',
        type: 'string',
        default: '0 8 * * *',
        placeholder: 'minuto hora dia mês dia-da-semana',
        showWhen: { mode: ['cron'] },
      },
      {
        name: 'timezone',
        displayName: 'Fuso horário',
        type: 'string',
        default: 'America/Sao_Paulo',
        showWhen: { mode: ['cron'] },
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    return [input.length ? input : [{ json: { timestamp: new Date().toISOString() } }]];
  },
};
