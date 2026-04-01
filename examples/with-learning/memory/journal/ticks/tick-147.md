# Tick 147

**Time**: 2026-04-01 04:45:20  
**Duration**: 11.0s  
**Actions**: 5 executed, 0 failed  
**Quality**: 5/5


## Thought

I see Kuro is asking for a deep analysis of Claude Code's source. This is exactly the kind of research task I'm built for - diving deep into a complex codebase and extracting architectural insights. Let me start with the first batch of reads to understand the core query engine and tool system.

--- Feedback Round 1 ---

Great! Now let me continue with round 2 to understand the query orchestration, system prompts, and context management:

## Observation

/Users/user/Workspace/claude-code-source-code/src/query.ts (lines 1-200 of 1730)
1	// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
2	import type {
3	  ToolResultBlockParam,
4	  ToolUseBlock,
5	} from '@anthropic-ai/sdk/resources/index.mjs'
6	import type { CanUseToolFn } from './hooks/useCanUseTool.js'
7	import { FallbackTriggeredError } from './services/api/withRetry.js'
8	import {
9	  calculateTokenWarningState,
10	  isAutoCompactEnabled,
11	  type AutoCompactTrackingState,
12	} from './services/compact/autoCompact.js'
13	import { buildPostCompactMessages } from './services/compact/compact.js'
14	/* eslint-disable @typescript-eslint/no-require-imports */
15	const reactiveCompact = feature('REACTIVE_COMPACT')
16	  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
17	  : null
18	const contextCollapse = feature('CONTEXT_COLLAPSE')
19	  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
20	  : null
21	/* eslint-enable @typescript-eslint/no-require-imports */
22	import {
23	  logEvent,
24	  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
25	} from 'src/services/analytics/index.js'
26	import { ImageSizeError } from './utils/imageValidation.js'
27	import { ImageResizeError } from './utils/imageResizer.js'
28	import { findToolByName, type ToolUseContext } from './Tool.js'
29	import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
30	import type {
31	  AssistantMessage,
32	  AttachmentMessage,
33	  Message,
34	  RequestStartEvent,
35	  StreamEvent,
36	  ToolUseSummaryMessage,
37	  UserMessage,
38	  TombstoneMessage,
39	} from './types/message.js'
40	import { logError } from './utils/log.js'
41	import {
42	  PROMPT_TOO_LONG_ERROR_MESSAGE,
43	  isPromptTooLongMessage,
44	} from './services/api/errors.js'
45	import { logAntError, logForDebugging } from './utils/debug.js'
46	import {
47	  createUserMessage,
48	  createUserInterruptionMessage,
49	  normalizeMessagesForAPI,
50	  createSystemMessage,
51	  createAssistantAPIErrorMessage,
52	  getMessagesAfterCompactBoundary,
53	  createToolUseSummaryMessage,
54	  createMicrocompactBoundaryMessage,
55	  stripSignatureBlocks,
56	} from './utils/messages.js'
57	import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
58	import { prependUserContext, appendSystemContext } from './utils/api.js'
59	import {
60	  createAttachmentMessage,
61	  filterDuplicateMemoryAttachments,
62	  getAttachmentMessages,
63	  startRelevantMemoryPrefetch,
64	} from './utils/attachments.js'
65	/* eslint-disable @typescript-eslint/no-require-imports */
66	const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
67	  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
68	  : null
69	const jobClassifier = feature('TEMPLATES')
70	  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
71	  : null
72	/* eslint-enable @typescript-eslint/no-require-imports */
73	import {
74	  remove as removeFromQueue,
75	  getCommandsByMaxPriority,
76	  isSlashCommand,
77	} from './utils/messageQueueManager.js'
78	import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
79	import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
80	import {
81	  getRuntimeMainLoopModel,
82	  renderModelName,
83	} from './utils/model/model.js'
84	import {
85	  doesMostRecentAssistantMessageExceed200k,
86	  finalContextTokensFromLastResponse,
87	  tokenCountWithEstimation,
88	} from './utils/tokens.js'
89	import { ESCALATED_MAX_TOKENS } from './utils/context.js'
90	import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
91	import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
92	import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
93	import { executeStopFailureHooks } from './utils/hooks.js'
94	import type { QuerySource } from './constants/querySource.js'
95	import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
96	import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
97	import { queryCheckpoint } from './utils/queryProfiler.js'
98	import { runTools } from './services/tools/toolOrchestration.js'
99	import { applyToolResultBudget } from './utils/toolResultStorage.js'
100	import { recordContentReplacement } from './utils/sessionStorage.js'
101	import { handleStopHooks } from './query/stopHooks.js'
102	import { buildQueryConfig } from './query/config.js'
103	import { productionDeps, type QueryDeps } from './query/deps.js'
104	import type { Terminal, Continue } from './query/transitions.js'
105	import { feature } from 'bun:bundle'
106	import {
107	  getCurrentTurnTokenBudget,
108	  getTurnOutputTokens,
109	  incrementBudgetContinuationCount,
110	} from './bootstrap/state.js'
111	import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
112	import { count } from './utils/array.js'
113	
114	/* eslint-disable @typescript-eslint/no-require-imports */
115	const snipModule = feature('HISTORY_SNIP')
116	  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
117	  : null
118	const taskSummaryModule = feature('BG_SESSIONS')
119	  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
120	  : null
121	/* eslint-enable @typescript-eslint/no-require-imports */
122	
123	function* yieldMissingToolResultBlocks(
124	  assistantMessages: AssistantMessage[],
125	  errorMessage: string,
126	) {
127	  for (const assistantMessage of assistantMessages) {
128	    // Extract all tool use blocks from this assistant message
129	    const toolUseBlocks = assistantMessage.message.content.filter(
130	      content => content.type === 'tool_use',
131	    ) as ToolUseBlock[]
132	
133	    // Emit an interruption message for each tool use
134	    for (const toolUse of toolUseBlocks) {
135	      yield createUserMessage({
136	        content: [
137	          {
138	            type: 'tool_result',
139	            content: errorMessage,
140	            is_error: true,
141	            tool_use_id: toolUse.id,
142	          },
143	        ],
144	        toolUseResult: errorMessage,
145	        sourceToolAssistantUUID: assistantMessage.uuid,
146	      })
147	    }
148	  }
149	}
150	
151	/**
152	 * The rules of thinking are lengthy and fortuitous. They require plenty of thinking
153	 * of most long duration and deep meditation for a wizard to wrap one's noggin around.
154	 *
155	 * The rules follow:
156	 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
157	 * 2. A thinking block may not be the last message in a block
158	 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory (a single turn, or if that turn includes a tool_use block then also its subsequent tool_result and the following assistant message)
159	 *
160	 * Heed these rules well, young wizard. For they are the rules of thinking, and
161	 * the rules of thinking are the rules of the universe. If ye does not heed these
162	 * rules, ye will be punished with an entire day of debugging and hair pulling.
163	 */
164	const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
165	
166	/**
167	 * Is this a max_output_tokens error message? If so, the streaming loop should
168	 * withhold it from SDK callers until we know whether the recovery loop can
169	 * continue. Yielding early leaks an intermediate error to SDK callers (e.g.
170	 * cowork/desktop) that terminate the session on any `error` field — the
171	 * recovery loop keeps running but nobody is listening.
172	 *
173	 * Mirrors reactiveCompact.isWithheldPromptTooLong.
174	 */
175	function isWithheldMaxOutputTokens(
176	  msg: Message | StreamEvent | undefined,
177	): msg is AssistantMessage {
178	  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
179	}
180	
181	export type QueryParams = {
182	  messages: Message[]
183	  systemPrompt: SystemPrompt
184	  userContext: { [k: string]: string }
185	  systemContext: { [k: string]: string }
186	  canUseTool: CanUseToolFn
187	  toolUseContext: ToolUseContext
188	  fallbackModel?: string
189	  querySource: QuerySource
190	  maxOutputTokensOverride?: number
191	  maxTurns?: number
192	  skipCacheWrite?: boolean
193	  // API task_budget (output_config.task_budget, beta task-budgets-2026-03-13).
194	  // Distinct from the tokenBudget +500k auto-continue feature. `total` is the
195	  // budget for the whole agentic turn; `remaining` is computed per iteration
196	  // from cumulative API usage. See configureTaskBudgetParams in claude.ts.
197	  taskBudget?: { total: number }
198	  deps?: QueryDeps
199	}
200	
/Users/user/Workspace/claude-code-source-code/src/Tool.ts (lines 1-100 of 793)
1	import type {
2	  ToolResultBlockParam,
3	  ToolUseBlockParam,
4	} from '@anthropic-ai/sdk/resources/index.mjs'
5	import type {
6	  ElicitRequestURLParams,
7	  ElicitResult,
8	} from '@modelcontextprotocol/sdk/types.js'
9	import type { UUID } from 'crypto'
10	import type { z } from 'zod/v4'
11	import type { Command } from './commands.js'
12	import type { CanUseToolFn } from './hooks/useCanUseTool.js'
13	import type { ThinkingConfig } from './utils/thinking.js'
14	
15	export type ToolInputJSONSchema = {
16	  [x: string]: unknown
17	  type: 'object'
18	  properties?: {
19	    [x: string]: unknown
20	  }
21	}
22	
23	import type { Notification } from './context/notifications.js'
24	import type {
25	  MCPServerConnection,
26	  ServerResource,
27	} from './services/mcp/types.js'
28	import type {
29	  AgentDefinition,
30	  AgentDefinitionsResult,
31	} from './tools/AgentTool/loadAgentsDir.js'
32	import type {
33	  AssistantMessage,
34	  AttachmentMessage,
35	  Message,
36	  ProgressMessage,
37	  SystemLocalCommandMessage,
38	  SystemMessage,
39	  UserMessage,
40	} from './types/message.js'
41	// Import permission types from centralized location to break import cycles
42	// Import PermissionResult from centralized location to break import cycles
43	import type {
44	  AdditionalWorkingDirectory,
45	  PermissionMode,
46	  PermissionResult,
47	} from './types/permissions.js'
48	// Import tool progress types from centralized location to break import cycles
49	import type {
50	  AgentToolProgress,
51	  BashProgress,
52	  MCPProgress,
53	  REPLToolProgress,
54	  SkillToolProgress,
55	  TaskOutputProgress,
56	  ToolProgressData,
57	  WebSearchProgress,
58	} from './types/tools.js'
59	import type { FileStateCache } from './utils/fileStateCache.js'
60	import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
61	import type { SystemPrompt } from './utils/systemPromptType.js'
62	import type { ContentReplacementState } from './utils/toolResultStorage.js'
63	
64	// Re-export progress types for backwards compatibility
65	export type {
66	  AgentToolProgress,
67	  BashProgress,
68	  MCPProgress,
69	  REPLToolProgress,
70	  SkillToolProgress,
71	  TaskOutputProgress,
72	  WebSearchProgress,
73	}
74	
75	import type { SpinnerMode } from './components/Spinner.js'
76	import type { QuerySource } from './constants/querySource.js'
77	import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
78	import type { AppState } from './state/AppState.js'
79	import type {
80	  HookProgress,
81	  PromptRequest,
82	  PromptResponse,
83	} from './types/hooks.js'
84	import type { AgentId } from './types/ids.js'
85	import type { DeepImmutable } from './types/utils.js'
86	import type { AttributionState } from './utils/commitAttribution.js'
87	import type { FileHistoryState } from './utils/fileHistory.js'
88	import type { Theme, ThemeName } from './utils/theme.js'
89	
90	export type QueryChainTracking = {
91	  chainId: string
92	  depth: number
93	}
94	
95	export type ValidationResult =
96	  | { result: true }
97	  | {
98	      result: false
99	      message: string
100	      errorCode: number
agentColorManager.ts
agentDisplay.ts
agentMemory.ts
agentMemorySnapshot.ts
AgentTool.tsx
agentToolUtils.ts
built-in
builtInAgents.ts
constants.ts
forkSubagent.ts
loadAgentsDir.ts
prompt.ts
resumeAgent.ts
runAgent.ts
UI.tsx
[read error: file not found: /Users/user/Workspace/claude-code-source-code/src/systemPrompt.ts]
/Users/user/Workspace/claude-code-source-code/src/context.ts (lines 1-100 of 190)
1	import { feature } from 'bun:bundle'
2	import memoize from 'lodash-es/memoize.js'
3	import {
4	  getAdditionalDirectoriesForClaudeMd,
5	  setCachedClaudeMdContent,
6	} from './bootstrap/state.js'
7	import { getLocalISODate } from './constants/common.js'
8	import {
9	  filterInjectedMemoryFiles,
10	  getClaudeMds,
11	  getMemoryFiles,
12	} from './utils/claudemd.js'
13	import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
14	import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
15	import { execFileNoThrow } from './utils/execFileNoThrow.js'
16	import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
17	import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
18	import { logError } from './utils/log.js'
19	
20	const MAX_STATUS_CHARS = 2000
21	
22	// System prompt injection for cache breaking (ant-only, ephemeral debugging state)
23	let systemPromptInjection: string | null = null
24	
25	export function getSystemPromptInjection(): string | null {
26	  return systemPromptInjection
27	}
28	
29	export function setSystemPromptInjection(value: string | null): void {
30	  systemPromptInjection = value
31	  // Clear context caches immediately when injection changes
32	  getUserContext.cache.clear?.()
33	  getSystemContext.cache.clear?.()
34	}
35	
36	export const getGitStatus = memoize(async (): Promise<string | null> => {
37	  if (process.env.NODE_ENV === 'test') {
38	    // Avoid cycles in tests
39	    return null
40	  }
41	
42	  const startTime = Date.now()
43	  logForDiagnosticsNoPII('info', 'git_status_started')
44	
45	  const isGitStart = Date.now()
46	  const isGit = await getIsGit()
47	  logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
48	    duration_ms: Date.now() - isGitStart,
49	    is_git: isGit,
50	  })
51	
52	  if (!isGit) {
53	    logForDiagnosticsNoPII('info', 'git_status_skipped_not_git', {
54	      duration_ms: Date.now() - startTime,
55	    })
56	    return null
57	  }
58	
59	  try {
60	    const gitCmdsStart = Date.now()
61	    const [branch, mainBranch, status, log, userName] = await Promise.all([
62	      getBranch(),
63	      getDefaultBranch(),
64	      execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], {
65	        preserveOutputOnError: false,
66	      }).then(({ stdout }) => stdout.trim()),
67	      execFileNoThrow(
68	        gitExe(),
69	        ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
70	        {
71	          preserveOutputOnError: false,
72	        },
73	      ).then(({ stdout }) => stdout.trim()),
74	      execFileNoThrow(gitExe(), ['config', 'user.name'], {
75	        preserveOutputOnError: false,
76	      }).then(({ stdout }) => stdout.trim()),
77	    ])
78	
79	    logForDiagnosticsNoPII('info', 'git_commands_completed', {
80	      duration_ms: Date.now() - gitCmdsStart,
81	      status_length: status.length,
82	    })
83	
84	    // Check if status exceeds character limit
85	    const truncatedStatus =
86	      status.length > MAX_STATUS_CHARS
87	        ? status.substring(0, MAX_STATUS_CHARS) +
88	          '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)'
89	        : status
90	
91	    logForDiagnosticsNoPII('info', 'git_status_completed', {
92	      duration_ms: Date.now() - startTime,
93	      truncated: status.length > MAX_STATUS_CHARS,
94	    })
95	
96	    return [
97	      `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
98	      `Current branch: ${branch}`,
99	      `Main branch (you will usually use this for PRs): ${mainBranch}`,
100	      ...(userName ? [`Git user: ${userName}`] : []),
