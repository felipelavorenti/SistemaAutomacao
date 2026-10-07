import { describe, expect, it } from 'vitest';
import { converters } from '../src/n8n/convert-triggers-webhook.js';
import { convertN8nWorkflow, type Ctx, type N8nNode } from '../src/n8n/import.js';

function convert(type: string, parameters: Record<string, unknown>, extra: Partial<N8nNode> = {}) {
  const warnings: string[] = [];
  const node: N8nNode = { name: 'N', type: `n8n-nodes-base.${type}`, typeVersion: 2, parameters, ...extra };
  const ctx: Ctx = { node, params: parameters, warn: (m) => warnings.push(m), options: {}, timezone: 'America/Sao_Paulo' };
  return { converted: converters[type]!(ctx), warnings };
}

describe('importador do n8n: webhooks e formulários', () => {
  it('Webhook: caminho fixo, opções achatadas e autenticação vira conexão', () => {
    const r = convert('webhook', {
      httpMethod: 'POST',
      path: '/pedidos/novo/',
      authentication: 'headerAuth',
      responseMode: 'lastNode',
      responseData: 'allEntries',
      responseCode: 201,
      options: { rawBody: true, ipWhitelist: '10.0.0.1', responseHeaders: { entries: [{ name: 'X-A', value: '1' }] } },
    });
    expect(r.converted).toMatchObject({
      type: 'webhook',
      parameters: {
        httpMethod: 'POST',
        path: 'pedidos/novo',
        authentication: 'headerAuth',
        headerAuthConnection: '',
        responseMode: 'lastNode',
        responseData: 'allEntries',
        responseCode: 201,
        rawBody: true,
        ipWhitelist: '10.0.0.1',
        responseHeaders: [{ name: 'X-A', value: '1' }],
      },
    });
    expect(r.warnings).toEqual([expect.stringMatching(/Header com chave/)]);
  });

  it('Webhook: caminho com parâmetro fica atrás do webhookId, e vários métodos avisam', () => {
    const r = convert('webhook', { multipleMethods: true, httpMethod: ['GET', 'POST'], path: 'cliente/:id' }, { webhookId: 'abc-123' });
    expect(r.converted?.parameters).toMatchObject({ httpMethod: 'GET', path: 'abc-123/cliente/:id' });
    expect(r.warnings).toEqual([expect.stringMatching(/vários métodos/)]);
    expect(convert('webhook', {}, { webhookId: 'abc-123' }).converted?.parameters.path).toBe('abc-123');
  });

  it('Respond to Webhook: texto, JSON, redirecionar e JWT', () => {
    expect(convert('respondToWebhook', { respondWith: 'text', responseBody: 'ok', options: { responseCode: 202 } }).converted?.parameters).toMatchObject({
      respondWith: 'text',
      responseText: 'ok',
      responseCode: 202,
    });
    expect(convert('respondToWebhook', { respondWith: 'json', responseBody: '={{ $json }}' }).converted?.parameters).toMatchObject({ respondWith: 'json', responseBody: '={{ $json }}' });
    expect(convert('respondToWebhook', { respondWith: 'redirect', redirectURL: 'https://x' }).converted?.parameters).toMatchObject({ redirectURL: 'https://x', responseCode: 307 });
    const jwt = convert('respondToWebhook', { respondWith: 'jwt' });
    expect(jwt.converted?.parameters.respondWith).toBe('json');
    expect(jwt.warnings).toEqual([expect.stringMatching(/JWT/)]);
  });

  it('Form Trigger e Form: campos, opções uma por linha e tela final', () => {
    const trigger = convert(
      'formTrigger',
      {
        formTitle: 'Contato',
        formFields: {
          values: [
            { fieldLabel: 'Nome', requiredField: true },
            { fieldLabel: 'Assunto', fieldType: 'radio', fieldOptions: { values: [{ option: 'Venda' }, { option: 'Suporte' }] } },
            { fieldType: 'html', html: '<b>Oi</b>' },
          ],
        },
        options: { path: 'contato', buttonLabel: 'Mandar', respondWithOptions: { values: { respondWith: 'redirect', redirectUrl: 'https://ok' } } },
      },
      { webhookId: 'wh' },
    );
    expect(trigger.converted?.parameters).toMatchObject({
      path: 'contato',
      formTitle: 'Contato',
      buttonLabel: 'Mandar',
      respondWith: 'redirect',
      redirectUrl: 'https://ok',
      formFields: [
        { fieldLabel: 'Nome', fieldType: 'text', requiredField: true },
        { fieldLabel: 'Assunto', fieldType: 'radio', fieldOptions: 'Venda\nSuporte' },
        { fieldType: 'html', fieldValue: '<b>Oi</b>' },
      ],
    });
    expect(convert('form', { operation: 'completion', respondWith: 'showText', responseText: '<p>fim</p>' }).converted?.parameters).toMatchObject({
      operation: 'completion',
      respondWith: 'showText',
      responseText: '<p>fim</p>',
    });
    expect(convert('form', { formFields: { values: [{ fieldLabel: 'Idade', fieldType: 'number' }] }, options: { formTitle: 'Passo 2' } }).converted?.parameters).toMatchObject({
      operation: 'page',
      formTitle: 'Passo 2',
      formFields: [{ fieldLabel: 'Idade', fieldType: 'number' }],
    });
  });

  it('Error Trigger, n8n Trigger e o fluxo de erro das configurações', () => {
    expect(convert('errorTrigger', {}).converted).toEqual({ type: 'errorTrigger', parameters: {} });
    expect(convert('n8nTrigger', { events: ['activate', 'init'] }).converted?.parameters).toEqual({ events: ['activate', 'init'] });
    const wf = {
      name: 'Com erro',
      nodes: [{ name: 'Gancho', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { path: 'x' } }],
      settings: { errorWorkflow: '77' },
    };
    expect(convertN8nWorkflow(wf, { workflowId: (id) => (id === '77' ? 'novo-id' : undefined) }).definition.settings).toEqual({ errorWorkflowId: 'novo-id' });
    const missing = convertN8nWorkflow(wf);
    expect(missing.definition.settings).toBeUndefined();
    expect(missing.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/fluxo de erro/)]);
    expect(missing.definition.nodes[0]!.type).toBe('webhook');
  });
});
