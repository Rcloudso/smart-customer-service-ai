export type OnboardingStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'dismissed'
  | 'legacy';

export interface OnboardingState {
  installKind: 'fresh' | 'legacy';
  status: OnboardingStatus;
  runId: string | null;
  startedAt: string | null;
  sampleLoadedAt: string | null;
  firstAnswerAt: string | null;
  firstAnswerSessionId: string | null;
  firstAnswerMessageId: string | null;
  evidenceReviewedAt: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
  lastFailureCode: string | null;
}

export interface SamplePackInstallation {
  packVersion: string;
  status: 'installing' | 'ready' | 'failed';
  faqIds: string[];
  documentId: string | null;
  attemptId: string | null;
  failureCode: string | null;
  completedAt: string | null;
}
