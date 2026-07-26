import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  EscalationCategory,
  EscalationEvidenceSource,
  EscalationExtractionMode,
  EscalationFact,
  EscalationPacket,
  EscalationPriority,
  EscalationQueue,
  EscalationReasonCode,
  EscalationRiskFlag,
  EscalationStatus,
} from '../../types/domain';
import { escapeLikePattern } from '../../utils/sql';

export interface EscalationListFilters {
  status?: EscalationStatus;
  category?: EscalationCategory;
  priority?: EscalationPriority;
  recommendedQueue?: EscalationQueue;
  keyword?: string;
}

export interface EscalationListItem {
  id: string;
  sessionId: string;
  userIdent: string;
  reason: string;
  status: EscalationStatus;
  resolvedAt: string | null;
  createdAt: string;
  packet: EscalationPacket;
}

export class EscalationPacketRepo {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private findByEscalationIdStmt: Database.Statement;
  private findBySessionStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO escalation_packets (
         escalation_id, session_id, schema_version, rule_version, summary,
         category, priority, reason_code, reason, risk_flags, confirmed_facts,
         missing_information, evidence_sources, recommended_queue,
         suggested_next_step, extraction_mode, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findByEscalationIdStmt = db.prepare(
      'SELECT * FROM escalation_packets WHERE escalation_id = ?',
    );
    this.findBySessionStmt = db.prepare(
      'SELECT * FROM escalation_packets WHERE session_id = ? ORDER BY created_at DESC, escalation_id DESC LIMIT 1',
    );
  }

  create(packet: EscalationPacket): EscalationPacket {
    this.insertStmt.run(
      packet.escalationId,
      packet.sessionId,
      packet.schemaVersion,
      packet.ruleVersion,
      packet.summary,
      packet.category,
      packet.priority,
      packet.reasonCode,
      packet.reason,
      JSON.stringify(packet.riskFlags),
      JSON.stringify(packet.confirmedFacts),
      JSON.stringify(packet.missingInformation),
      JSON.stringify(packet.evidenceSources),
      packet.recommendedQueue,
      packet.suggestedNextStep,
      packet.extractionMode,
      packet.createdAt,
      packet.updatedAt,
    );
    return packet;
  }

  findByEscalationId(escalationId: string): EscalationPacket | null {
    const row = this.findByEscalationIdStmt.get(escalationId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findBySession(sessionId: string): EscalationPacket | null {
    const row = this.findBySessionStmt.get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  listLatestBySession(
    filters: EscalationListFilters,
    limit: number,
    offset: number,
  ): EscalationListItem[] {
    const statusFilter = this.buildStatusFilterSql(filters);
    const packetFilters = this.buildPacketFilterSql(filters);
    const rows = this.db.prepare(
      `WITH ranked AS (
         SELECT
           e.id, e.session_id, e.reason AS escalation_reason, e.status,
           e.resolved_at, e.created_at AS escalation_created_at,
           s.user_ident,
           p.*,
           ROW_NUMBER() OVER (
             PARTITION BY e.session_id
             ORDER BY e.created_at DESC, e.id DESC
           ) AS row_number
         FROM escalation_log e
         JOIN escalation_packets p ON p.escalation_id = e.id
         JOIN sessions s ON s.id = e.session_id
         ${statusFilter.whereClause}
       )
       SELECT * FROM ranked
       WHERE row_number = 1
         ${packetFilters.andClause}
       ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
         escalation_created_at ASC
       LIMIT ? OFFSET ?`,
    ).all(
      ...statusFilter.params,
      ...packetFilters.params,
      limit,
      offset,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapListRow(row));
  }

  countLatestBySession(filters: EscalationListFilters): number {
    const statusFilter = this.buildStatusFilterSql(filters);
    const packetFilters = this.buildPacketFilterSql(filters);
    const row = this.db.prepare(
      `WITH ranked AS (
         SELECT
           e.session_id,
           e.reason AS escalation_reason,
           p.summary,
           p.category,
           p.priority,
           p.recommended_queue,
           ROW_NUMBER() OVER (
             PARTITION BY e.session_id
             ORDER BY e.created_at DESC, e.id DESC
           ) AS row_number
         FROM escalation_log e
         JOIN escalation_packets p ON p.escalation_id = e.id
         JOIN sessions s ON s.id = e.session_id
         ${statusFilter.whereClause}
       )
       SELECT COUNT(*) AS total FROM ranked
       WHERE row_number = 1
         ${packetFilters.andClause}`,
    ).get(...statusFilter.params, ...packetFilters.params) as { total: number };
    return row.total;
  }

  private mapRow(row: Record<string, unknown>): EscalationPacket {
    return {
      escalationId: row.escalation_id as string,
      sessionId: row.session_id as string,
      schemaVersion: row.schema_version as number,
      ruleVersion: row.rule_version as string,
      summary: row.summary as string,
      category: row.category as EscalationCategory,
      priority: row.priority as EscalationPriority,
      reasonCode: row.reason_code as EscalationReasonCode,
      reason: row.reason as string,
      riskFlags: parseJsonArray(row.risk_flags, escalationRiskFlagSchema),
      confirmedFacts: parseJsonArray(row.confirmed_facts, escalationFactSchema),
      missingInformation: parseJsonArray(row.missing_information, missingInformationSchema),
      evidenceSources: parseJsonArray(row.evidence_sources, escalationEvidenceSchema),
      recommendedQueue: row.recommended_queue as EscalationQueue,
      suggestedNextStep: row.suggested_next_step as string,
      extractionMode: row.extraction_mode as EscalationExtractionMode,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapListRow(row: Record<string, unknown>): EscalationListItem {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      userIdent: row.user_ident as string,
      reason: row.escalation_reason as string,
      status: row.status as EscalationStatus,
      resolvedAt: row.resolved_at as string | null,
      createdAt: row.escalation_created_at as string,
      packet: this.mapRow(row),
    };
  }

  private buildStatusFilterSql(filters: EscalationListFilters): {
    whereClause: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.status) {
      clauses.push('e.status = ?');
      params.push(filters.status);
    }
    return {
      whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  private buildPacketFilterSql(filters: EscalationListFilters): {
    andClause: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.category) {
      clauses.push('category = ?');
      params.push(filters.category);
    }
    if (filters.priority) {
      clauses.push('priority = ?');
      params.push(filters.priority);
    }
    if (filters.recommendedQueue) {
      clauses.push('recommended_queue = ?');
      params.push(filters.recommendedQueue);
    }
    if (filters.keyword?.trim()) {
      const keyword = `%${escapeLikePattern(filters.keyword.trim())}%`;
      clauses.push(`(
        summary LIKE ? ESCAPE '\\'
        OR escalation_reason LIKE ? ESCAPE '\\'
        OR session_id LIKE ? ESCAPE '\\'
      )`);
      params.push(keyword, keyword, keyword);
    }
    return {
      andClause: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '',
      params,
    };
  }
}

const escalationRiskFlagSchema = z.enum([
  'account_security',
  'unauthorized_transaction',
  'safety_risk',
  'private_data_required',
  'business_action_required',
  'knowledge_conflict',
  'complaint',
  'low_confidence',
]);
const escalationFactSchema: z.ZodType<EscalationFact> = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(500),
  sourceMessageId: z.string().trim().min(1),
  sourceExcerpt: z.string().trim().min(1).max(300),
}).strict();
const missingInformationSchema = z.string().trim().min(1).max(120);
const escalationEvidenceSchema: z.ZodType<EscalationEvidenceSource> = z.object({
  knowledgeType: z.enum(['faq', 'document']),
  knowledgeId: z.string().min(1),
  documentId: z.string().optional(),
  title: z.string(),
  similarity: z.number(),
  chunkIndex: z.number().int().optional(),
  pageStart: z.number().int().optional(),
  pageEnd: z.number().int().optional(),
}).strict();

function parseJsonArray<T>(value: unknown, itemSchema: z.ZodType<T>): T[] {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    const result = z.array(itemSchema).safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
