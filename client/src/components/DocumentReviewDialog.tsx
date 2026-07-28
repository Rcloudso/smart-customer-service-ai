import React from 'react';
import {
  Button,
  Dialog,
  Input,
  Popconfirm,
  Switch,
  Tag,
  Textarea,
} from 'tdesign-react';
import { CloseIcon, RefreshIcon } from 'tdesign-icons-react';
import type { DocumentBlock, DocumentItem } from '../types';
import { useDocumentReviewDraft } from '../hooks/useDocumentReviewDraft';
import { useTranslation } from '../hooks/usePreferences';

interface DocumentReviewDialogProps {
  document: DocumentItem | null;
  onClose: () => void;
  onPublished: (document: DocumentItem) => void | Promise<void>;
}

export function DocumentReviewDialog({
  document,
  onClose,
  onPublished,
}: DocumentReviewDialogProps): React.ReactElement {
  const {
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
  } = useDocumentReviewDraft({ document, onClose, onPublished });

  return (
    <Dialog
      visible={Boolean(document)}
      header={t('documents.reviewTitle')}
      closeBtn={(
        <Button
          variant="text"
          shape="square"
          aria-label={t('common.close')}
          icon={<CloseIcon />}
          onClick={requestClose}
          data-testid="document-review-close"
        />
      )}
      footer={false}
      width="min(1120px, calc(100vw - 32px))"
      onClose={requestClose}
      destroyOnClose
    >
      {document && (
        <div className="app-document-review" data-testid="document-review-dialog" aria-busy={loading}>
          <header className="app-document-review__header">
            <div>
              <strong>{document.fileName}</strong>
              <span>{t('documents.reviewDescription')}</span>
            </div>
            <div className="app-document-review__summary">
              <Tag variant="light">{t('documents.reviewRevision', { revision: revision ?? '—' })}</Tag>
              <Tag variant="light">{t('documents.reviewBlockCount', { count: blocks.length })}</Tag>
              <Tag theme={dirty ? 'warning' : 'success'} variant="light">
                {t(dirty ? 'documents.reviewUnsaved' : 'documents.reviewSavedState')}
              </Tag>
            </div>
          </header>

          {loading ? (
            <div className="app-document-empty-note">{t('common.loading')}</div>
          ) : blocks.length === 0 ? (
            <div className="app-document-empty-note">{t('documents.reviewEmpty')}</div>
          ) : (
            <div className="app-document-review__workspace">
              <nav className="app-document-review__blocks" aria-label={t('documents.reviewBlockNavigation')}>
                {blocks.map((block, index) => (
                  <Button
                    key={block.id}
                    variant={index === selectedIndex ? 'outline' : 'text'}
                    theme={index === selectedIndex ? 'primary' : 'default'}
                    size="small"
                    className="app-document-review__block-button"
                    onClick={() => setSelectedIndex(index)}
                    data-testid={`document-review-block-${index}`}
                  >
                    <span>{index + 1}</span>
                    <span>{t(`documents.blockType.${block.kind}`)}</span>
                    <small>{block.pageNumber ? t('documents.reviewPage', { page: block.pageNumber }) : '—'}</small>
                  </Button>
                ))}
              </nav>

              {selectedBlock && (
                <section className="app-document-review__editor" aria-labelledby="document-review-editor-title">
                  <div className="app-document-review__editor-header">
                    <div>
                      <h3 id="document-review-editor-title">
                        {t('documents.reviewBlockTitle', { index: selectedIndex + 1 })}
                      </h3>
                      <div className="app-document-review__block-meta">
                        <span>{selectedBlock.id} · {t(`documents.blockType.${selectedBlock.kind}`)}</span>
                        {selectedBlock.confidence !== null && (
                          <Tag variant="light">
                            {t('documents.reviewConfidence', {
                              confidence: Math.round(selectedBlock.confidence * 100),
                            })}
                          </Tag>
                        )}
                        {selectedBlock.layout && (
                          <Tag variant="light">
                            {t('documents.reviewLayout', {
                              x: Math.round(selectedBlock.layout.x),
                              y: Math.round(selectedBlock.layout.y),
                              width: Math.round(selectedBlock.layout.width),
                              height: Math.round(selectedBlock.layout.height),
                            })}
                          </Tag>
                        )}
                      </div>
                    </div>
                    <label className="app-document-review__include">
                      <span>{t('documents.reviewInclude')}</span>
                      <Switch
                        value={!selectedBlock.excluded}
                        onChange={(included: boolean) => replaceSelected({
                          ...selectedBlock,
                          excluded: !included,
                          exclusionReason: included ? null : 'manual_exclusion',
                        })}
                        data-testid="document-review-include"
                      />
                    </label>
                  </div>
                  <BlockEditor block={selectedBlock} onChange={replaceSelected} />
                  <div className="app-document-review__pager">
                    <Button
                      variant="outline"
                      disabled={selectedIndex === 0}
                      onClick={() => setSelectedIndex((index) => Math.max(index - 1, 0))}
                    >
                      {t('documents.reviewPrevious')}
                    </Button>
                    <span>{t('documents.reviewProgress', { current: selectedIndex + 1, total: blocks.length })}</span>
                    <Button
                      variant="outline"
                      disabled={selectedIndex === blocks.length - 1}
                      onClick={() => setSelectedIndex((index) => Math.min(index + 1, blocks.length - 1))}
                    >
                      {t('documents.reviewNext')}
                    </Button>
                  </div>
                </section>
              )}
            </div>
          )}

          <footer className="app-document-review__footer">
            <span>
              {t('documents.reviewEditedCount', { count: editedCount })}
            </span>
            <div>
              <Button
                variant="outline"
                icon={<RefreshIcon />}
                onClick={() => void loadDraft()}
                disabled={loading || saving || publishing}
              >
                {t('documents.reviewReload')}
              </Button>
              <Button
                theme="primary"
                variant="outline"
                onClick={() => void saveDraft()}
                disabled={!dirty || status !== 'open'}
                loading={saving}
                data-testid="document-review-save"
              >
                {t('common.save')}
              </Button>
              <Popconfirm
                content={t('documents.reviewPublishConfirm')}
                onConfirm={() => void publishDraft()}
              >
                <Button
                  theme="primary"
                  disabled={dirty || status !== 'open' || blocks.length === 0}
                  loading={publishing}
                  data-testid="document-review-publish"
                >
                  {t('documents.reviewPublish')}
                </Button>
              </Popconfirm>
            </div>
          </footer>
        </div>
      )}
    </Dialog>
  );
}

function BlockEditor({
  block,
  onChange,
}: {
  block: DocumentBlock;
  onChange: (block: DocumentBlock) => void;
}): React.ReactElement {
  const { t } = useTranslation();

  if (block.kind === 'text' || block.kind === 'heading' || block.kind === 'paragraph') {
    return (
      <Textarea
        value={block.text ?? ''}
        onChange={(text: string) => onChange({ ...block, text })}
        autosize={{ minRows: 10, maxRows: 18 }}
        placeholder={t('documents.reviewTextPlaceholder')}
        data-testid="document-review-text"
      />
    );
  }

  if (block.kind === 'list') {
    return (
      <Textarea
        value={(block.items ?? []).map((item) => item.text).join('\n')}
        onChange={(value: string) => onChange({
          ...block,
          items: value.split('\n').map((text, ordinal) => ({ ordinal, text })),
        })}
        autosize={{ minRows: 10, maxRows: 18 }}
        placeholder={t('documents.reviewListPlaceholder')}
        data-testid="document-review-list"
      />
    );
  }

  if (block.kind === 'table') {
    return (
      <div className="app-document-review__field-list" data-testid="document-review-table">
        {(block.cells ?? []).map((cell, index) => (
          <label key={`${cell.rowIndex}-${cell.columnIndex}-${index}`}>
            <span>{t('documents.reviewTableCell', { row: cell.rowIndex + 1, column: cell.columnIndex + 1 })}</span>
            <Textarea
              value={cell.text}
              autosize={{ minRows: 2, maxRows: 5 }}
              onChange={(text: string) => onChange({
                ...block,
                cells: (block.cells ?? []).map((candidate, cellIndex) => (
                  cellIndex === index ? { ...candidate, text } : candidate
                )),
              })}
            />
          </label>
        ))}
      </div>
    );
  }

  if (block.kind === 'key_value') {
    return (
      <div className="app-document-review__field-list" data-testid="document-review-key-value">
        {(block.pairs ?? []).map((pair, index) => (
          <div className="app-document-review__pair" key={`${index}-${pair.key}`}>
            <Input
              value={pair.key}
              placeholder={t('documents.reviewKeyPlaceholder')}
              onChange={(key: string) => onChange({
                ...block,
                pairs: (block.pairs ?? []).map((candidate, pairIndex) => (
                  pairIndex === index ? { ...candidate, key } : candidate
                )),
              })}
            />
            <Input
              value={pair.value}
              placeholder={t('documents.reviewValuePlaceholder')}
              onChange={(value: string) => onChange({
                ...block,
                pairs: (block.pairs ?? []).map((candidate, pairIndex) => (
                  pairIndex === index ? { ...candidate, value } : candidate
                )),
              })}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <Textarea
      value={block.altText ?? ''}
      onChange={(altText: string) => onChange({ ...block, altText })}
      autosize={{ minRows: 8, maxRows: 14 }}
      placeholder={t('documents.reviewImagePlaceholder')}
      data-testid="document-review-image"
    />
  );
}
