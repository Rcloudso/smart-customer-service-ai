import { useEffect, useMemo, useState } from 'react';
import { MessagePlugin } from 'tdesign-react';
import * as adminApi from '../api/admin';
import { ApiError } from '../api/client';
import type { DocumentBlock, DocumentItem } from '../types';
import { useTranslation } from './usePreferences';

interface UseDocumentReviewDraftOptions {
  document: DocumentItem | null;
  onClose: () => void;
  onPublished: (document: DocumentItem) => void | Promise<void>;
}

export function useDocumentReviewDraft({
  document,
  onClose,
  onPublished,
}: UseDocumentReviewDraftOptions) {
  const { t } = useTranslation();
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [status, setStatus] = useState<'open' | 'published' | 'superseded' | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadDraft = async () => {
    if (!document) return;
    setLoading(true);
    try {
      const result = await adminApi.listDocumentReviewDraftBlocks(document.id, 1, 2_000);
      setBlocks(result.items ?? []);
      setRevision(result.revision);
      setStatus(result.status);
      setSelectedIndex((current) => (
        Math.min(current, Math.max((result.items?.length ?? 1) - 1, 0))
      ));
      setDirty(false);
    } catch {
      MessagePlugin.error(t('documents.reviewLoadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setBlocks([]);
    setRevision(null);
    setStatus(null);
    setSelectedIndex(0);
    setDirty(false);
    if (document) void loadDraft();
  }, [document?.id]);

  const selectedBlock = blocks[selectedIndex] ?? null;
  const editedCount = useMemo(
    () => blocks.filter((block) => block.manuallyEdited).length,
    [blocks],
  );

  const replaceSelected = (next: DocumentBlock) => {
    setBlocks((current) => current.map((block, index) => (
      index === selectedIndex ? next : block
    )));
    setDirty(true);
  };

  const saveDraft = async () => {
    if (!document || revision === null || status !== 'open') return;
    setSaving(true);
    try {
      const result = await adminApi.updateDocumentReviewDraft(document.id, revision, blocks);
      setBlocks(result.items);
      setRevision(result.revision);
      setStatus(result.status);
      setDirty(false);
      MessagePlugin.success(t('documents.reviewSaved'));
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 409) {
        MessagePlugin.warning(t('documents.reviewConflict'));
        await loadDraft();
      } else {
        MessagePlugin.error(t('documents.reviewSaveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const publishDraft = async () => {
    if (!document || revision === null || dirty || status !== 'open') return;
    setPublishing(true);
    try {
      const published = await adminApi.publishDocumentReviewDraft(document.id, revision);
      if (
        published.status !== 'ready'
        || published.indexStatus !== 'published'
        || published.reviewDraftSummary?.status !== 'published'
      ) {
        MessagePlugin.error(t('documents.reviewPublishFailed'));
        return;
      }
      setStatus('published');
      MessagePlugin.success(t('documents.reviewPublished'));
      await onPublished(published);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 409) {
        MessagePlugin.warning(t('documents.reviewConflict'));
        await loadDraft();
      } else {
        MessagePlugin.error(t('documents.reviewPublishFailed'));
      }
    } finally {
      setPublishing(false);
    }
  };

  const requestClose = () => {
    if (dirty && !window.confirm(t('documents.reviewDiscardConfirm'))) return;
    onClose();
  };

  return {
    t,
    blocks,
    revision,
    status,
    selectedIndex,
    selectedBlock,
    editedCount,
    loading,
    saving,
    publishing,
    dirty,
    setSelectedIndex,
    replaceSelected,
    loadDraft,
    saveDraft,
    publishDraft,
    requestClose,
  };
}
