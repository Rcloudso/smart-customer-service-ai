import { logger } from '../utils/logger';
import { DocumentService } from './document.service';

export class DocumentOcrScheduler {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;

  constructor(
    private readonly documentService: DocumentService,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    const recovered = this.documentService.recoverInterruptedOcrJobs();
    if (recovered > 0) {
      logger.warn({ recovered }, 'Interrupted OCR extraction jobs returned to the queue');
    }
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    this.timer.unref();
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.active;
  }

  private tick(): void {
    if (this.active) return;
    const active = this.documentService.processNextOcrJob()
      .then(() => undefined)
      .catch((error) => {
        logger.error({
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, 'OCR scheduler iteration failed');
      })
      .finally(() => {
        if (this.active === active) this.active = null;
      });
    this.active = active;
  }
}
