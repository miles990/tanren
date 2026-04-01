# Tick 139

**Time**: 2026-04-01 04:19:06  
**Duration**: 7.6s  
**Actions**: 2 executed, 0 failed  
**Quality**: 5/5


## Thought

I'll start this deep research task by exploring the Claude Code source structure systematically, then provide a comprehensive analysis comparing it with Tanren.

--- Feedback Round 1 ---



--- Feedback Round 2 ---



## Observation

assistant
bootstrap
bridge
buddy
cli
commands
commands.ts
components
constants
context
context.ts
coordinator
cost-tracker.ts
costHook.ts
dialogLaunchers.tsx
entrypoints
history.ts
hooks
ink
ink.ts
interactiveHelpers.tsx
keybindings
main.tsx
memdir
migrations
moreright
native-ts
outputStyles
plugins
projectOnboardingState.ts
query
query.ts
QueryEngine.ts
remote
replLauncher.tsx
schemas
screens
server
services
setup.ts
skills
state
Task.ts
tasks
tasks.ts
Tool.ts
tools
tools.ts
types
upstreamproxy
utils
vim
voice
/Users/user/Workspace/claude-code-source-code/src/query.ts (lines 1-150 of 1730)
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
