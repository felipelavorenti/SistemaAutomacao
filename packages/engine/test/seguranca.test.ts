import { describe, expect, it } from 'vitest';
import { renderFormPage, sanitizeCss, sanitizeHtml } from '../src/forms.js';
import { gitEnv } from '../src/nodes/git.js';

describe('Segurança das páginas de formulário', () => {
  it('o CSS próprio não fecha o bloco de estilo', () => {
    for (const css of ['</style><script>alert(1)</script>', '</sty</stylele><script>alert(1)</script>', '<</style/style>']) {
      const page = renderFormPage({ title: 'T', fields: [], customCss: css }, { action: '/form/t' });
      expect(page.match(/<\/style>/gi)).toHaveLength(1);
      expect(page).not.toMatch(/<script/i);
    }
    expect(sanitizeCss('a::after{content:"<"}')).toBe('a::after{content:"\\3c "}');
  });

  it('o bloco HTML não deixa tag sem fechar virar atributo de evento', () => {
    expect(sanitizeHtml('<b>oi</b><img src=x onerror=alert(1) ')).toBe('<b>oi</b>&lt;img src=x onerror=alert(1) ');
    expect(sanitizeHtml('<scr<script>x</script>ipt>alert(1)</script>')).not.toMatch(/<script/i);
    expect(sanitizeHtml('<p onclick="x()">Texto & mais</p><a href="javascript:alert(1)">link</a>')).toBe('<p>Texto & mais</p><a>link</a>');
    expect(sanitizeHtml('<img src="https://x/y.png" alt="logo">')).toBe('<img src="https://x/y.png" alt="logo">');
  });
});

describe('Segurança do nó Git', () => {
  it('não passa ao git as variáveis secretas do servidor', () => {
    process.env.ENCRYPTION_KEY = 'chave-secreta';
    process.env.DATABASE_URL = 'postgres://u:senha@db/x';
    process.env.HTTPS_PROXY = 'http://proxy:3128';
    const env = gitEnv();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});
