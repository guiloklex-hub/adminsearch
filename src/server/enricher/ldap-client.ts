import { readFile } from 'node:fs/promises';
import { Client } from 'ldapts';
import type { AppLogger } from '@server/logger.ts';

export interface LdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  tlsCaFile?: string | undefined;
  tlsInsecure?: boolean | undefined;
}

/**
 * Wrapper fino sobre `ldapts.Client` que mantém uma conexão persistente, refaz
 * o bind sob demanda e expõe métodos de busca tipados.
 *
 * Single-instance é suficiente para o volume esperado (poucos milhares de
 * users + grupos sob expansão recursiva).
 */
export class LdapPool {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly tlsCa: Buffer | null;

  constructor(
    private readonly cfg: LdapConfig,
    private readonly logger: AppLogger,
    tlsCa: Buffer | null = null,
  ) {
    this.tlsCa = tlsCa;
  }

  static async create(cfg: LdapConfig, logger: AppLogger): Promise<LdapPool> {
    let tlsCa: Buffer | null = null;
    if (cfg.tlsCaFile) {
      try {
        tlsCa = await readFile(cfg.tlsCaFile);
      } catch (err) {
        logger.error({ err, path: cfg.tlsCaFile }, 'falha ao ler LDAP_TLS_CA_FILE');
      }
    }
    return new LdapPool(cfg, logger, tlsCa);
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const tlsOptions: { ca?: Buffer; rejectUnauthorized?: boolean } = {};
      if (this.tlsCa) tlsOptions.ca = this.tlsCa;
      if (this.cfg.tlsInsecure) {
        tlsOptions.rejectUnauthorized = false;
        this.logger.warn(
          'LDAP_TLS_INSECURE=true — validacao de cert do LDAPS desabilitada. Vulneravel a MITM.',
        );
      }

      const client = new Client({
        url: this.cfg.url,
        timeout: 10_000,
        connectTimeout: 5_000,
        tlsOptions: Object.keys(tlsOptions).length > 0 ? tlsOptions : undefined,
      });
      await client.bind(this.cfg.bindDn, this.cfg.bindPassword);
      this.client = client;
      this.logger.info('ldap bind ok');
      return client;
    })().catch((err) => {
      this.connecting = null;
      this.client = null;
      throw err;
    });

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async search<T = Record<string, unknown>>(
    filter: string,
    attributes: string[],
    options?: { scope?: 'base' | 'one' | 'sub'; sizeLimit?: number },
  ): Promise<T[]> {
    const client = await this.getClient();
    try {
      const { searchEntries, searchReferences } = await client.search(this.cfg.baseDn, {
        filter,
        attributes,
        scope: options?.scope ?? 'sub',
        sizeLimit: options?.sizeLimit ?? 0,
        // Garante que atributos binários (objectSid, objectGUID) venham
        // como Buffer ao invés de string base64.
        explicitBufferAttributes: ['objectSid', 'objectGUID'],
      });

      // Log diagnóstico — extremamente útil pra debugar permissões e bugs do
      // ldapts. Truncamos o filter pra não estourar log com SIDs binários.
      const filterShort = filter.length > 200 ? `${filter.slice(0, 200)}...` : filter;
      this.logger.debug(
        {
          filter: filterShort,
          attributes,
          entries: searchEntries.length,
          refs: searchReferences?.length ?? 0,
        },
        'ldap search',
      );

      return searchEntries as unknown as T[];
    } catch (err) {
      // Reconecta na próxima chamada
      try {
        await this.client?.unbind();
      } catch {
        /* ignore */
      }
      this.client = null;
      throw err;
    }
  }

  async testBind(): Promise<void> {
    const client = await this.getClient();
    await client.search(this.cfg.baseDn, { filter: '(objectClass=*)', scope: 'base', sizeLimit: 1 });
  }

  async dispose(): Promise<void> {
    if (this.client) {
      try {
        await this.client.unbind();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }
}
