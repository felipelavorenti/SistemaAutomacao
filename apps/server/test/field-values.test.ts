import { describe, expect, it } from 'vitest';
import { mergeValues } from '../src/lib/catalog.js';
import { getConnectionType, mergeData } from '../src/lib/connection-types.js';

describe('valores dos campos enviados pela API', () => {
  it('guarda número e sim/não como texto nos dados da conexão', () => {
    const data = mergeData(getConnectionType('postgres')!, { host: 'db', port: 5433, database: 'loja', user: 'app', ssl: true });
    expect(data).toMatchObject({ port: '5433', ssl: 'true' });
  });

  it('guarda número como texto no cadastro do cliente no ERP', () => {
    const values = mergeValues([{ name: 'porta', label: 'Porta', secret: false }], { porta: 8080 });
    expect(values.porta).toBe('8080');
  });

  it('ignora listas e objetos, e segredo vazio mantém o valor salvo', () => {
    const type = getConnectionType('postgres')!;
    const data = mergeData(type, { host: ['a'], password: '' }, { password: 'salva' });
    expect(data).toMatchObject({ host: '', password: 'salva' });
  });
});
