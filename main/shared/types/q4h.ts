/**
 * Q4H (Questions for Human) Types
 * Data structures for Q4H feature implementation
 * Note: Wire protocol types are defined in wire.ts (DriveDialogByUserAnswer)
 */

/**
 * Individual human question data structure
 * Note: This is an INDEX entry - the actual question content is in dialog's conversation messages
 */
export interface HumanQuestion {
  /** UUID - index entry identifier, NOT source of truth */
  readonly id: string;
  /** Question kind discriminator for UI behavior */
  readonly kind: 'generic' | 'keep_going_budget_exhausted' | 'context_health_critical';
  /** Question headline/title */
  readonly headLine: string;
  /** Detailed question context */
  readonly bodyContent: string;
  /** ISO timestamp when question was asked */
  readonly askedAt: string;
  /** Reference to the @human call site in conversation */
  readonly callSiteRef: {
    /** Course number where @human was called */
    course: number;
    /** Message index within the course */
    messageIndex: number;
  };
}

/**
 * Dialog context for hierarchical Q4H display
 */
export interface Q4HDialogContext {
  /** Dialog self ID */
  readonly selfId: string;
  /** Dialog root ID (for subdialogs, points to parent) */
  readonly rootId: string;
  /** Agent ID who asked the question */
  readonly agentId: string;
  /** Task document path for display */
  readonly taskDocPath: string;
  /** Questions from this dialog */
  readonly questions: HumanQuestion[];
}

/**
 * New Q4H Asked Event - emitted when agent asks a new question
 */
export interface NewQ4HAskedEvent {
  type: 'new_q4h_asked';
  question: GlobalQ4HQuestion;
}

/**
 * Q4H Answered Event - emitted when user answers a question
 */
export interface Q4HAnsweredEvent {
  type: 'q4h_answered';
  questionId: string;
  selfId: string;
}

/**
 * Extended Q4H question with dialog context (used for global Q4H display)
 * The backend provides this format when responding to get_all_q4h_state
 */
export interface GlobalQ4HQuestion extends HumanQuestion {
  /** Dialog self ID */
  selfId: string;
  /** Dialog root ID (for subdialogs, points to parent) */
  rootId: string;
  /** Agent ID who asked the question */
  agentId: string;
  /** Task document path for display */
  taskDocPath: string;
}

/**
 * Navigation event detail for Q4H call site navigation
 */
export interface Q4HNavigationDetail {
  /** Question ID being answered */
  questionId: string;
  /** Dialog containing the question */
  selfId: string;
  /** Root dialog ID for context */
  rootId: string;
  /** Course number of the @human call site */
  course: number;
  /** Message index within the course */
  messageIndex: number;
}
