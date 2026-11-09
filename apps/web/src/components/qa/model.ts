import { useMemo } from 'react';
import type { BadgeTone } from '@/components/ui/badge';
import { useWsEntities, type EntityRow } from '@/lib/queries';

// 实体的 data 是 JSON，形状由 qa 插件 manifest 决定，这里按字段收窄
export interface SuiteData { name: string; command: string; report_path: string; coverage_path?: string; timeout_sec?: number; auto_run?: boolean; description?: string }
export interface Step { action: string; expected: string }
export interface Handoff { taskId: string; workstationId: string; artifactId: string }
export interface CaseData { title: string; module?: string; priority?: string; status?: string; preconditions?: string; steps?: Step[]; requirement?: string; automation_key?: string; automation_name?: string; handoff?: Handoff }
export interface ManualResult { status: 'passed' | 'failed' | 'blocked' | 'skipped'; note?: string; at: string }
export interface Criteria { minPassRate?: number; minCoverage?: number | null }
export interface PlanData { name: string; version?: string; ref?: string; status?: 'draft' | 'running' | 'signed'; suites?: string[]; cases?: string[]; criteria?: Criteria; manual_results?: Record<string, ManualResult>; run_ids?: Record<string, string>; summary?: string; signoff?: { at: string; level: string; note?: string; artifactId: string; override: boolean } }
export interface BugData { title: string; severity: string; status?: string; module?: string; steps?: string; expected?: string; actual?: string; run_id?: string; case_key?: string; case_name?: string; handoff?: Handoff; verifying_since?: string; note?: string }

export interface Doc<T> { id: string; version: number; createdAt: string; updatedAt: string | null; authorType: string | null; data: T }

const toDoc = <T,>(e: EntityRow): Doc<T> => ({ id: e.id, version: e.version, createdAt: e.createdAt, updatedAt: e.updatedAt, authorType: e.createdByType, data: JSON.parse(e.dataJson ?? '{}') as T });

export function useDocs<T>(wsId: string, type: string) {
  const q = useWsEntities(wsId);
  const rows = q.data?.entities;
  const docs = useMemo(() => (rows ?? []).filter((e) => e.entityType === type).map(toDoc<T>), [rows, type]);
  return { docs, isLoading: q.isLoading, error: q.error };
}

export const RUN_LABEL: Record<string, string> = { queued: '排队中', running: '运行中', passed: '通过', failed: '失败', error: '出错', canceled: '已取消', interrupted: '已中断' };
export const RUN_TONE: Record<string, BadgeTone> = { queued: 'cool', running: 'cool', passed: 'ok', failed: 'bad', error: 'bad', canceled: 'neutral', interrupted: 'bad' };
export const CASE_LABEL: Record<string, string> = { passed: '通过', failed: '失败', error: '错误', skipped: '跳过', blocked: '阻塞' };
export const CASE_TONE: Record<string, BadgeTone> = { passed: 'ok', failed: 'bad', error: 'bad', skipped: 'neutral', blocked: 'amber' };
export const TRIGGER_LABEL: Record<string, string> = { human: '手动', agent: 'Agent', auto: '自动回归', plan: '测试计划', retry: '重跑' };
export const VERDICT_LABEL: Record<string, string> = { ready: '可发布', risk: '有风险', blocked: '阻断', unknown: '还没有结果' };
export const VERDICT_TONE: Record<string, BadgeTone> = { ready: 'ok', risk: 'amber', blocked: 'bad', unknown: 'neutral' };
export const TRIAGE_LABEL: Record<string, string> = { product_bug: '产品缺陷', test_bug: '测试问题', environment: '环境问题', flaky: '不稳定' };
export const CONFIDENCE_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
export const BUG_LABEL: Record<string, string> = { draft: '草稿', open: '待修', fixing: '修复中', verifying: '待验证', verified: '已验证', reopened: '重开', wontfix: '不修复' };
export const BUG_TONE: Record<string, BadgeTone> = { draft: 'amber', open: 'bad', fixing: 'cool', verifying: 'amber', verified: 'ok', reopened: 'bad', wontfix: 'neutral' };
export const SEVERITY_TONE: Record<string, BadgeTone> = { p0: 'bad', p1: 'bad', p2: 'amber', p3: 'neutral' };
export const CASE_STATUS_LABEL: Record<string, string> = { draft: '草稿', active: '有效', deprecated: '已废弃' };
export const CASE_STATUS_TONE: Record<string, BadgeTone> = { draft: 'amber', active: 'ok', deprecated: 'neutral' };
export const PLAN_LABEL: Record<string, string> = { draft: '草稿', running: '进行中', signed: '已签字' };

export const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`);
export const isActive = (s: string) => s === 'queued' || s === 'running';
