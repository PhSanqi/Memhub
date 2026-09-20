/** Memory runtime module. */
import { z } from "zod";
/** Schema for iso time. */
export const IsoTimeSchema = z.string().datetime();
/** Schema for cursor. */
export const CursorSchema = z.string();
/** Schema for memory kind. */
export const MemoryKindSchema = z.enum([
    "trace",
    "span",
    "timeline",
    "project_profile",
    "user_profile",
    "skill"
]);
/** Schema for memory layer. */
export const MemoryLayerSchema = z.enum(["L1", "L2", "L3", "L4", "Skill"]);
export const RecallMemoryLayerSchema = z.enum(["L1", "L2", "L3", "L4", "Skill"]);
/** Schema for memory status. */
export const MemoryStatusSchema = z.enum(["activated", "resolving", "archived", "deleted"]);
/** Schema for job status. */
export const JobStatusSchema = z.enum(["queued", "leased", "succeeded", "failed", "dead_letter"]);
/** Schema for job type. */
export const JobTypeSchema = z.enum([
    "episode_idle_close",
    "trace_summary",
    "import_summary",
    "reflection",
    "embedding",
    "reward",
    "span_big_turn",
    "skill_trial_resolve"
]);
const NonEmptyStringSchema = z.string().min(1);
const UnknownRecordSchema = z.record(z.string(), z.unknown());
export const InjectedContextSectionSchema = z.object({
    id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    kind: MemoryKindSchema,
    memoryLayer: RecallMemoryLayerSchema,
    memoryIds: z.array(NonEmptyStringSchema),
    content: z.string(),
    tokenEstimate: z.number().int().nonnegative().optional()
});
/** Schema for injected context. */
export const InjectedContextSchema = z.object({
    markdown: z.string(),
    sections: z.array(InjectedContextSectionSchema),
    tokenEstimate: z.number().int().nonnegative().optional()
});
/** Schema for recall hit. */
export const RecallHitSchema = z.object({
    id: NonEmptyStringSchema,
    kind: MemoryKindSchema,
    memoryLayer: RecallMemoryLayerSchema,
    status: MemoryStatusSchema,
    title: z.string().optional(),
    snippet: z.string(),
    score: z.number(),
    tags: z.array(z.string()),
    createdAt: IsoTimeSchema.optional(),
    updatedAt: IsoTimeSchema.optional(),
    source: z.enum(["search", "episode", "rule", "skill"]),
    sourceTurnId: z.string().optional(),
    memberMemoryIds: z.array(NonEmptyStringSchema).optional(),
    retrievalRoutes: z.array(z.enum(["l1", "agent_memory"])).optional(),
    sourceAgentId: z.string().optional(),
    sourceSkillId: z.string().optional(),
    sourceSkillVersion: z.string().optional(),
    readOnly: z.boolean().optional(),
    members: z.array(z.object({
        id: NonEmptyStringSchema,
        kind: MemoryKindSchema,
        memoryLayer: RecallMemoryLayerSchema,
        status: z.union([MemoryStatusSchema, z.enum(["active", "archived", "deleted"])]),
        content: z.string(),
        createdAt: IsoTimeSchema,
        updatedAt: IsoTimeSchema,
        retrievalRoute: z.enum(["l1", "agent_memory"])
    })).optional()
});
const MemoryCaptureDiagnosticsSchema = z.object({
    status: z.enum(["pending", "completed"]),
    decided_at: IsoTimeSchema.optional(),
    l1: z.array(z.object({
        memory_id: NonEmptyStringSchema,
        written: z.boolean()
    })).optional()
});
export const RecallEvidenceOutputSchema = z.object({
    recallEventId: NonEmptyStringSchema,
    queryId: NonEmptyStringSchema,
    query: z.string(),
    hits: z.array(RecallHitSchema),
    diagnostics: z.object({
        candidateMemoryIds: z.array(NonEmptyStringSchema),
        injectedMemoryIds: z.array(NonEmptyStringSchema),
        capture: MemoryCaptureDiagnosticsSchema.optional()
    }).optional(),
    createdAt: IsoTimeSchema,
    serverTime: IsoTimeSchema
});
/** Schema for memory metrics. */
export const MemoryMetricsSchema = z.object({
    value: z.number().optional(),
    alpha: z.number().optional(),
    reflectionDone: z.boolean()
});
export const MemoryProcessingStateSchema = z.enum([
    "summary_pending",
    "summarizing",
    "embedding_pending",
    "embedding",
    "ready",
    "ready_text_only",
    "failed"
]);
export const MemoryProcessingRecordSchema = z.object({
    memoryId: NonEmptyStringSchema,
    state: MemoryProcessingStateSchema,
    stage: z.enum(["summary", "embedding"]).nullable().optional(),
    activeJobId: NonEmptyStringSchema.nullable().optional(),
    attemptCount: z.number().int().nonnegative(),
    manualRetryCount: z.number().int().nonnegative(),
    retryAction: z.enum(["retry", "open_settings", "none"]),
    errorCode: z.string().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
    failedAt: IsoTimeSchema.nullable().optional(),
    autoRetryScheduled: z.boolean().optional(),
    updatedAt: IsoTimeSchema
});
export const MemoryListItemSchema = z.object({
    id: NonEmptyStringSchema,
    kind: MemoryKindSchema,
    memoryLayer: RecallMemoryLayerSchema,
    status: MemoryStatusSchema,
    title: NonEmptyStringSchema,
    summary: z.string(),
    tags: z.array(z.string()),
    processing: MemoryProcessingRecordSchema.optional(),
    metrics: MemoryMetricsSchema.optional(),
    metadata: UnknownRecordSchema.optional(),
    createdAt: IsoTimeSchema,
    updatedAt: IsoTimeSchema,
    version: z.number().int().nonnegative()
});
export const PanelMemoryListItemSchema = MemoryListItemSchema;
/** Definition for memory detail item. */
export const MemoryDetailItemSchema = MemoryListItemSchema.extend({
    body: z.string(),
    createdAt: IsoTimeSchema,
    sourceMemoryIds: z.array(NonEmptyStringSchema),
    metadata: UnknownRecordSchema
});
/** Schema for raw turn summary. */
export const RawTurnSummarySchema = z.object({
    rawTurnId: NonEmptyStringSchema,
    episodeId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    userText: z.string().optional(),
    assistantText: z.string().optional(),
    reasoningSummary: z.string().optional(),
    toolCalls: z.array(z.unknown()).optional(),
    toolResults: z.array(z.unknown()).optional(),
    createdAt: IsoTimeSchema
});
/** Schema for episode ref. */
export const EpisodeRefSchema = z.object({
    id: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    title: z.string().optional(),
    summary: z.string().optional(),
    status: z.enum(["open", "processing", "closed"]),
    startedAt: IsoTimeSchema.optional(),
    endedAt: IsoTimeSchema.optional(),
    turnCount: z.number().int().nonnegative().optional(),
    rTask: z.number().optional(),
    rewardSkipped: z.boolean().optional(),
    rewardReason: z.string().optional(),
    closeReason: z.string().optional(),
    topicState: z.string().optional(),
    abandonReason: z.string().optional(),
    pipelineStatus: z.enum(["idle", "running", "succeeded", "failed"]).optional(),
    pipelineError: z.string().optional(),
    skillMemoryIds: z.array(NonEmptyStringSchema).optional(),
    linkedSkillId: NonEmptyStringSchema.optional(),
    skillStatus: z.string().optional(),
    skillReason: z.string().optional()
});
/** Schema for job ref. */
export const JobRefSchema = z.object({
    jobId: NonEmptyStringSchema,
    jobType: JobTypeSchema,
    status: JobStatusSchema,
    targetMemoryId: NonEmptyStringSchema.optional()
});
/** Schema for runtime request fields. */
const RuntimeRequestFieldsSchema = z.object({
    requestId: NonEmptyStringSchema.optional(),
    adapterId: NonEmptyStringSchema.optional(),
    source: NonEmptyStringSchema.optional()
});
export const MemoryModelStatusSchema = z.object({
    provider: z.string(),
    model: z.string().optional(),
    configured: z.boolean(),
    remote: z.boolean(),
    lastOkAt: IsoTimeSchema.optional(),
    lastError: z.string().optional()
});
export const MemoryModelsStatusSchema = z.object({
    summary: MemoryModelStatusSchema.extend({
        routing: z.enum(["follow", "fixed"]).nullable()
    }),
    evolution: MemoryModelStatusSchema.extend({
        routing: z.enum(["follow", "fixed"]).nullable()
    }),
    embedding: MemoryModelStatusSchema.extend({
        mode: z.enum(["cloud", "local", "custom"]).nullable()
    })
});
/** Schema for memory health snapshot. */
export const MemoryHealthSnapshotSchema = z.object({
    ok: z.boolean(),
    version: NonEmptyStringSchema,
    uptimeMs: z.number().nonnegative(),
    mode: z.enum(["local", "cloud", "dev"]),
    storage: z.object({
        backend: z.enum(["sqlite", "polardb"]),
        schemaVersion: NonEmptyStringSchema,
        ready: z.boolean(),
        lastMigrationId: z.string().optional()
    }),
    capabilities: z.object({
        routes: z.array(z.string()),
        tools: z.array(z.string()),
        memoryLayers: z.array(MemoryLayerSchema),
        supportsCli: z.boolean()
    }),
    models: MemoryModelsStatusSchema,
    serverTime: IsoTimeSchema
});
export const MemoryReloadConfigInputSchema = RuntimeRequestFieldsSchema.extend({
    reason: z.string().optional(),
    restartFailedProcessing: z.boolean().optional()
});
export const MemoryReloadConfigOutputSchema = z.object({
    changed: z.boolean(),
    requiresRestart: z.boolean(),
    models: MemoryModelsStatusSchema,
    reloadedAt: IsoTimeSchema
});
export const OpenSessionInputSchema = RuntimeRequestFieldsSchema.extend({
    sessionId: NonEmptyStringSchema.optional(),
    workspacePath: z.string().optional()
}).strict();
/** Schema for open session output. */
export const OpenSessionOutputSchema = z.object({
    sessionId: NonEmptyStringSchema,
    status: z.literal("open"),
    episodeId: NonEmptyStringSchema.optional(),
    resumed: z.boolean(),
    projectId: NonEmptyStringSchema.nullable().optional(),
    serverTime: IsoTimeSchema
});
/** Definition for close session input. */
export const CloseSessionInputSchema = RuntimeRequestFieldsSchema.passthrough();
/** Schema for close session output. */
export const CloseSessionOutputSchema = z.object({
    ok: z.literal(true),
    sessionId: NonEmptyStringSchema,
    status: z.literal("closed"),
    closedEpisodeIds: z.array(NonEmptyStringSchema),
    changeSeq: z.number().int().nonnegative().optional(),
    syncCursor: CursorSchema.optional(),
    serverTime: IsoTimeSchema
});
/** Definition for start turn input. */
export const StartTurnInputSchema = RuntimeRequestFieldsSchema.extend({
    sessionId: NonEmptyStringSchema,
    query: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema.optional(),
    contextHints: UnknownRecordSchema.optional(),
    contextBudget: z.number().int().nonnegative().optional()
});
/** Schema for start turn output. */
export const StartTurnOutputSchema = z.object({
    turnId: NonEmptyStringSchema,
    contextPacketId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    injectedContext: InjectedContextSchema,
    searchEventId: NonEmptyStringSchema,
    sourceMemoryIds: z.array(NonEmptyStringSchema),
    hits: z.array(RecallHitSchema),
    status: z.array(z.string()),
    serverTime: IsoTimeSchema
});
/** Definition for complete turn input. */
export const CompleteTurnInputSchema = RuntimeRequestFieldsSchema.extend({
    sessionId: NonEmptyStringSchema,
    episodeId: NonEmptyStringSchema.optional(),
    query: NonEmptyStringSchema,
    answer: NonEmptyStringSchema,
    reasoningSummary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    toolCalls: z.array(z.unknown()).optional(),
    toolResults: z.array(z.unknown()).optional(),
    artifacts: z.array(z.unknown()).optional(),
    sourceMemoryIds: z.array(NonEmptyStringSchema).optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["succeeded", "failed"]).optional()
});
/** Schema for complete turn output. */
export const CompleteTurnOutputSchema = z.object({
    turnId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    episodeId: NonEmptyStringSchema,
    rawTurnId: NonEmptyStringSchema,
    l1MemoryId: z.string(),
    l1MemoryIds: z.array(NonEmptyStringSchema),
    closedEpisodeIds: z.array(NonEmptyStringSchema),
    scheduledEvolution: z.boolean(),
    jobs: z.array(JobRefSchema),
    changeSeq: z.number().int().nonnegative(),
    serverTime: IsoTimeSchema,
    duplicate: z.boolean().optional()
});
/** Definition for search input. */
export const SearchInputSchema = RuntimeRequestFieldsSchema.extend({
    query: NonEmptyStringSchema,
    sessionId: z.string().optional(),
    episodeId: z.string().optional(),
    turnId: z.string().optional(),
    layers: z.array(MemoryLayerSchema).optional(),
    verbose: z.boolean().optional()
});
/** Schema for default search output. */
export const DefaultSearchOutputSchema = z.object({
    injectedContext: z.string()
}).strict();
export const VerboseSearchDebugSchema = z.object({
    searchEventId: NonEmptyStringSchema,
    hits: z.array(RecallHitSchema),
    sourceMemoryIds: z.array(NonEmptyStringSchema),
    status: z.array(z.string()),
    sections: z.array(InjectedContextSectionSchema),
    tokenEstimate: z.number().int().nonnegative().optional(),
    serverTime: IsoTimeSchema
});
export const VerboseSearchOutputSchema = z.object({
    injectedContext: z.string(),
    debug: VerboseSearchDebugSchema
}).strict();
export const SearchOutputSchema = z.union([VerboseSearchOutputSchema, DefaultSearchOutputSchema]);
/** Definition for add memory input. */
export const AddMemoryInputSchema = RuntimeRequestFieldsSchema.extend({
    content: NonEmptyStringSchema,
    layer: MemoryLayerSchema.optional(),
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
    source: z.string().optional(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    createdAt: IsoTimeSchema.optional(),
    deferProcessing: z.boolean().optional(),
    sourceAgentId: z.string().optional(),
    sourceSkillId: z.string().optional(),
    sourceSkillPath: z.string().optional(),
    sourceSkillVersion: z.string().optional(),
    sourceContentHash: z.string().optional()
});
/** Schema for add memory output. */
export const AddMemoryOutputSchema = z.object({
    id: NonEmptyStringSchema,
    kind: MemoryKindSchema,
    memoryLayer: MemoryLayerSchema,
    status: MemoryStatusSchema,
    title: NonEmptyStringSchema,
    summary: z.string(),
    tags: z.array(z.string()),
    createdAt: IsoTimeSchema,
    serverTime: IsoTimeSchema,
    duplicate: z.boolean().optional()
});
/** Schema for get memory output. */
export const GetMemoryOutputSchema = z.object({
    item: MemoryDetailItemSchema.extend({
        trace: z
            .object({
            episodeId: NonEmptyStringSchema,
            rawTurnId: NonEmptyStringSchema,
            turnId: NonEmptyStringSchema
        })
            .optional(),
        skill: z
            .object({
            invocationGuide: z.string(),
            retrievalBlurb: z.string().optional(),
            triggerContext: z.string().optional(),
            procedure: z.array(z.string()).optional(),
            sourceMemoryIds: z.array(NonEmptyStringSchema),
            reliabilityScore: z.number().optional(),
            utilityScore: z.number().optional(),
            evidenceCount: z.number().int().nonnegative().optional()
        })
            .optional()
    }),
    refs: z
        .object({
        rawTurn: RawTurnSummarySchema.optional(),
        episode: EpisodeRefSchema.optional(),
        skillTrials: z
            .array(z.object({
            trialId: NonEmptyStringSchema,
            status: z.enum(["pending", "pass", "fail", "unknown"]),
            episodeId: NonEmptyStringSchema.optional(),
            reward: z.number().optional()
        }))
            .optional()
    })
        .optional(),
    version: z.number().int().nonnegative(),
    etag: z.string().optional()
});
/** Definition for delete memory input. */
export const DeleteMemoryInputSchema = RuntimeRequestFieldsSchema;
/** Schema for delete memory output. */
export const DeleteMemoryOutputSchema = z.object({
    ok: z.literal(true),
    id: NonEmptyStringSchema,
    kind: MemoryKindSchema,
    status: z.literal("deleted"),
    changeSeq: z.number().int().nonnegative(),
    syncCursor: CursorSchema,
    auditId: NonEmptyStringSchema.optional(),
    serverTime: IsoTimeSchema
});
/** Schema for worker run output. */
export const WorkerRunOutputSchema = z.object({
    leased: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    jobs: z.array(JobRefSchema),
    embeddingRetries: z.object({
        leased: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        items: z.array(z.object({
            id: NonEmptyStringSchema,
            status: z.string(),
            targetKind: z.string(),
            targetMemoryId: NonEmptyStringSchema,
            vectorField: z.string(),
            attempts: z.number().int().nonnegative(),
            lastError: z.string().nullable().optional()
        }))
    }),
    changeSeq: z.number().int().nonnegative(),
    syncCursor: CursorSchema,
    serverTime: IsoTimeSchema
});
/** Schema for enqueue import summaries output. */
export const EnqueueImportSummariesOutputSchema = z.object({
    enqueued: z.number().int().nonnegative(),
    memoryIds: z.array(NonEmptyStringSchema),
    serverTime: IsoTimeSchema
});
export const MemoryProcessingStatusInputSchema = RuntimeRequestFieldsSchema.extend({
    memoryIds: z.array(NonEmptyStringSchema).max(10_000)
});
export const MemoryProcessingStatusOutputSchema = z.object({
    items: z.array(MemoryProcessingRecordSchema),
    serverTime: IsoTimeSchema
});
export const RetryMemoryProcessingOutputSchema = z.object({
    accepted: z.boolean(),
    processing: MemoryProcessingRecordSchema,
    job: JobRefSchema.optional(),
    serverTime: IsoTimeSchema
});
/** Schema for panel items input. */
export const PanelItemsInputSchema = z.object({
    layer: RecallMemoryLayerSchema.optional(),
    status: MemoryStatusSchema.optional(),
    q: z.string().optional(),
    sourceAgent: z.string().trim().min(1).optional(),
    excludedSourceAgents: z.array(z.string().trim().min(1)).optional(),
    page: z.coerce.number().int().positive().optional()
});
/** Schema for panel task list input. */
export const PanelTasksInputSchema = z.object({
    q: z.string().optional(),
    page: z.coerce.number().int().positive().optional()
});
/** Schema for memory api log tool name. */
export const MemoryApiLogToolNameSchema = z.enum(["memory_add", "memory_search", "skill_generate", "skill_evolve"]);
/** Schema for memory api logs input. */
export const MemoryApiLogsInputSchema = z.object({
    tools: z.array(MemoryApiLogToolNameSchema).optional(),
    sourceAgent: z.string().trim().min(1).optional(),
    excludedSourceAgents: z.array(z.string().trim().min(1)).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().nonnegative().optional()
});
/** Schema for panel change kind. */
export const PanelChangeKindSchema = z.union([
    MemoryKindSchema,
    z.enum(["session", "episode", "job", "feedback", "raw_turn", "repair", "skill_trial", "recall", "artifact"])
]);
/** Schema for panel changes input. */
export const PanelChangesInputSchema = z.object({
    cursor: CursorSchema.optional(),
    kind: PanelChangeKindSchema.optional(),
    limit: z.coerce.number().int().positive().optional()
});
/** Schema for panel jobs input. */
export const PanelJobsInputSchema = z.object({
    status: JobStatusSchema.optional(),
    jobType: JobTypeSchema.optional(),
    targetMemoryId: z.string().optional(),
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().positive().optional()
});
/** Schema for panel overview output. */
export const PanelOverviewOutputSchema = z.object({
    counts: z.object({
        memories: z.number().int().nonnegative(),
        skills: z.number().int().nonnegative(),
        timelines: z.number().int().nonnegative(),
        projectProfiles: z.number().int().nonnegative(),
        userProfiles: z.number().int().nonnegative()
    }),
    dailyActivity: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        count: z.number().int().nonnegative()
    })),
    sourceDistribution: z.array(z.object({
        source: z.string().min(1),
        count: z.number().int().nonnegative(),
        percentage: z.number().min(0).max(100)
    }))
});
/** Schema for panel analysis output. */
export const PanelAnalysisOutputSchema = z.object({
    metrics: z.object({
        avgRecallScore: z.number().nonnegative(),
        recallEvents: z.number().int().nonnegative(),
        activeSkills: z.number().int().nonnegative(),
        recentlyUsedSkills: z.number().int().nonnegative(),
        avgToolLatencyMs: z.number().int().nonnegative(),
        p95ToolLatencyMs: z.number().int().nonnegative()
    }),
    dailyMemoryWrites: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        count: z.number().int().nonnegative()
    })),
    dailySkillEvolutions: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        count: z.number().int().nonnegative()
    })),
    toolLatency: z.object({
        tools: z.array(z.object({
            name: z.string().min(1),
            calls: z.number().int().nonnegative(),
            avgMs: z.number().int().nonnegative(),
            p95Ms: z.number().int().nonnegative()
        })),
        series: z.array(z.object({
            name: z.string().min(1),
            points: z.array(z.object({
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                avgMs: z.number().int().nonnegative()
            }))
        }))
    })
});
/** Schema for panel items output. */
export const PanelItemsOutputSchema = z.object({
    items: z.array(PanelMemoryListItemSchema),
    page: z.number().int().positive(),
    pageSize: z.literal(20),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
    serverTime: IsoTimeSchema
});
/** Schema for a task shown in the memory panel. */
export const PanelTaskItemSchema = z.object({
    id: NonEmptyStringSchema,
    episode: EpisodeRefSchema,
    memoryIds: z.array(NonEmptyStringSchema),
    turns: z.array(RawTurnSummarySchema),
    updatedAt: IsoTimeSchema
});
/** Schema for panel task list output. */
export const PanelTasksOutputSchema = z.object({
    tasks: z.array(PanelTaskItemSchema),
    page: z.number().int().positive(),
    pageSize: z.literal(20),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
    serverTime: IsoTimeSchema
});
/** Schema for deleting a task from the memory panel. */
export const DeletePanelTaskOutputSchema = z.object({
    ok: z.literal(true),
    id: NonEmptyStringSchema,
    deletedMemoryIds: z.array(NonEmptyStringSchema),
    serverTime: IsoTimeSchema
});
/** Schema for memory api log. */
export const MemoryApiLogSchema = z.object({
    id: z.number().int().nonnegative(),
    toolName: MemoryApiLogToolNameSchema,
    sourceAgent: NonEmptyStringSchema.optional(),
    inputJson: z.string(),
    outputJson: z.string(),
    durationMs: z.number().int().nonnegative(),
    success: z.boolean(),
    calledAt: IsoTimeSchema
});
/** Schema for memory api logs output. */
export const MemoryApiLogsOutputSchema = z.object({
    logs: z.array(MemoryApiLogSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().optional(),
    serverTime: IsoTimeSchema
});
/** Schema for panel item detail output. */
export const PanelItemDetailOutputSchema = z.object({
    item: MemoryDetailItemSchema,
    version: z.number().int().nonnegative(),
    etag: NonEmptyStringSchema
});
/** Schema for panel changes output. */
export const PanelChangesOutputSchema = z.object({
    cursor: CursorSchema,
    serverTime: IsoTimeSchema,
    changes: z.array(z.object({
        seq: z.number().int().nonnegative(),
        op: z.enum(["created", "updated", "archived", "deleted"]),
        kind: PanelChangeKindSchema,
        id: NonEmptyStringSchema,
        version: z.number().int().nonnegative().optional(),
        source: z.enum(["turn_complete", "feedback", "worker", "panel", "system"]),
        updatedAt: IsoTimeSchema
    })),
    hasMore: z.boolean()
});
/** Schema for panel jobs output. */
export const PanelJobsOutputSchema = z.object({
    jobs: z.array(z.object({
        id: NonEmptyStringSchema,
        jobType: JobTypeSchema,
        status: JobStatusSchema,
        targetMemoryId: NonEmptyStringSchema.optional(),
        createdAt: IsoTimeSchema,
        updatedAt: IsoTimeSchema,
        error: z
            .object({
            code: NonEmptyStringSchema,
            message: z.string()
        })
            .optional()
    })),
    nextCursor: CursorSchema.optional()
});
/** Schema for api error code. */
export const ApiErrorCodeSchema = z.enum([
    "invalid_argument",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "rate_limited",
    "internal",
    "memory_layer_unavailable",
    "missing_idempotency_key",
    "idempotency_body_mismatch",
    "scan_not_permitted",
    "memory_recall_not_permitted",
    "skill_write_not_permitted",
    "agent_source_unavailable",
    "composio_not_configured",
    "toolkit_unsupported",
    "model_config_changed",
    "config_write_busy",
    "account_model_preset_conflict"
]);
/** Schema for api error body. */
export const ApiErrorBodySchema = z.object({
    error: z.object({
        code: ApiErrorCodeSchema,
        message: z.string(),
        requestId: NonEmptyStringSchema
    })
});
