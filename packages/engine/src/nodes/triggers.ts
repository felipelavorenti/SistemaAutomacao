import type { NodeType } from '../node-types.js';

const WEEKDAY_OPTIONS = [
  { name: 'Dom', value: '0' },
  { name: 'Seg', value: '1' },
  { name: 'Ter', value: '2' },
  { name: 'Qua', value: '3' },
  { name: 'Qui', value: '4' },
  { name: 'Sex', value: '5' },
  { name: 'Sáb', value: '6' },
];

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
          { name: 'Todo dia', value: 'daily' },
          { name: 'Toda semana', value: 'weekly' },
          { name: 'Todo mês', value: 'monthly' },
          { name: 'A cada intervalo', value: 'interval' },
          { name: 'Uma vez, numa data e hora', value: 'once' },
          { name: 'Expressão cron', value: 'cron' },
        ],
      },
      {
        name: 'intervalMinutes',
        displayName: 'Intervalo',
        type: 'number',
        default: 60,
        description: 'Quantidade de unidades entre uma execução e outra. Intervalos de poucos segundos enchem o histórico de Execuções.',
        showWhen: { mode: ['interval'] },
      },
      {
        name: 'intervalUnit',
        displayName: 'Unidade',
        type: 'options',
        default: 'minutes',
        options: [
          { name: 'Segundos', value: 'seconds' },
          { name: 'Minutos', value: 'minutes' },
          { name: 'Horas', value: 'hours' },
        ],
        showWhen: { mode: ['interval'] },
      },
      {
        name: 'weekdays',
        displayName: 'Dias da semana',
        type: 'multiOptions',
        default: ['1', '2', '3', '4', '5'],
        options: WEEKDAY_OPTIONS,
        showWhen: { mode: ['weekly'] },
      },
      {
        name: 'dayOfMonth',
        displayName: 'Dia do mês',
        type: 'number',
        default: 1,
        description: 'De 1 a 31. Nos meses que não têm esse dia (ex.: 31 em abril), não roda.',
        showWhen: { mode: ['monthly'] },
      },
      {
        name: 'time',
        displayName: 'Horário',
        type: 'time',
        default: '08:00:00',
        description: 'Hora, minuto e segundo.',
        showWhen: { mode: ['daily', 'weekly', 'monthly'] },
      },
      {
        name: 'dateTime',
        displayName: 'Data e hora',
        type: 'dateTime',
        default: '',
        required: true,
        description: 'Roda uma vez nesse momento e depois o fluxo é desativado sozinho.',
        showWhen: { mode: ['once'] },
      },
      {
        name: 'cron',
        displayName: 'Expressão cron',
        type: 'string',
        default: '0 8 * * *',
        placeholder: 'minuto hora dia mês dia-da-semana',
        description: '5 campos, ou 6 com os segundos no começo. Ex.: 0 8 * * 1-5 é de segunda a sexta às 8h.',
        showWhen: { mode: ['cron'] },
      },
      {
        name: 'timezone',
        displayName: 'Fuso horário',
        type: 'string',
        default: 'America/Sao_Paulo',
        showWhen: { mode: ['daily', 'weekly', 'monthly', 'once', 'cron'] },
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    return [input.length ? input : [{ json: { timestamp: new Date().toISOString() } }]];
  },
};
