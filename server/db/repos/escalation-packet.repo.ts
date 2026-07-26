import Database from 'better-sqlite3';
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
} from '../../types/domain';

export class EscalationPacketRepo {
  private insertStmt: Database.Statement;
  private findByEscalationIdStmt: Database.Statement;
  private findBySessionStmt: Database.Statement;

  constructor(db: Database.Database) {
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
      riskFlags: parseJsonArray<EscalationRiskFlag>(row.risk_flags),
      confirmedFacts: parseJsonArray<EscalationFact>(row.confirmed_facts),
      missingInformation: parseJsonArray<string>(row.missing_information),
      evidenceSources: parseJsonArray<EscalationEvidenceSource>(row.evidence_sources),
      recommendedQueue: row.recommended_queue as EscalationQueue,
      suggestedNextStep: row.suggested_next_step as string,
      extractionMode: row.extraction_mode as EscalationExtractionMode,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}
