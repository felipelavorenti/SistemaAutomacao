export type Role = 'admin' | 'editor' | 'operator' | 'viewer';

export const ROLES: Role[] = ['admin', 'editor', 'operator', 'viewer'];

export type Capability =
  | 'workflow:view'
  | 'workflow:edit'
  | 'workflow:execute'
  | 'execution:view'
  | 'connection:view'
  | 'connection:edit'
  | 'admin';

const CAPABILITIES: Record<Role, Capability[]> = {
  admin: ['workflow:view', 'workflow:edit', 'workflow:execute', 'execution:view', 'connection:view', 'connection:edit', 'admin'],
  editor: ['workflow:view', 'workflow:edit', 'workflow:execute', 'execution:view', 'connection:view', 'connection:edit'],
  operator: ['workflow:view', 'workflow:execute', 'execution:view', 'connection:view'],
  viewer: ['workflow:view', 'execution:view', 'connection:view'],
};

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  /** Pastas que o usuário enxerga; null = todas (administrador). */
  folderIds: string[] | null;
  /** Clientes cujas conexões o usuário enxerga; null = todos (administrador). */
  clientIds: string[] | null;
}

export function can(user: CurrentUser, capability: Capability): boolean {
  return CAPABILITIES[user.role].includes(capability);
}

export function canSeeFolder(user: CurrentUser, folderId: string): boolean {
  return user.folderIds === null || user.folderIds.includes(folderId);
}

/** Conexões sem cliente são visíveis para todos; as de cliente, só para quem tem acesso a ele. */
export function canSeeClient(user: CurrentUser, clientId: string | null): boolean {
  return clientId === null || user.clientIds === null || user.clientIds.includes(clientId);
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function forbidden(message = 'Você não tem permissão para esta ação'): HttpError {
  return new HttpError(403, message);
}

export function notFound(what = 'Registro'): HttpError {
  return new HttpError(404, `${what} não encontrado`);
}

export function requireCap(user: CurrentUser, capability: Capability): void {
  if (!can(user, capability)) throw forbidden();
}
