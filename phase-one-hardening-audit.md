# Phase 1 Hardening Audit

## Scope

Audit target:
- [src/vs/workbench/contrib/void/common/contextGathering/contextGatherer.ts](/home/shivam/Desktop/void/src/vs/workbench/contrib/void/common/contextGathering/contextGatherer.ts:1)

This is the read-only audit requested before replacing the overfit judgment layer.

## Verdict Summary

The current judgment layer is overfit to Void.

Most of the overfitting comes from three areas:
- Void-specific file names
- Void-specific architectural vocabulary
- intent categories tuned for LLM-tooling questions instead of general repo questions

All of those should be removed or replaced with structural signals.

## Hardcoded Rules

### Query intent categories

1. `prefersExecutionSites`
- Rule type: intent category
- Why overfit: not universally wrong, but it is still query-semantics tuning rather than structural evidence
- Verdict: `replace`

2. `prefersImplementations`
- Rule type: intent category
- Why overfit: same issue; tied to hand-authored interpretations of user wording
- Verdict: `replace`

3. `prefersDefinitions`
- Rule type: intent category
- Why overfit: same issue
- Verdict: `replace`

4. `prefersWiring`
- Rule type: LLM/tooling-specific intent category
- Why overfit: “wiring” is not a generic repo concept for ranking
- Verdict: `delete`

5. `prefersPromptTemplates`
- Rule type: LLM/prompt-specific intent category
- Why overfit: only makes sense in prompt-system architecture
- Verdict: `delete`

6. `prefersDirectories`
- Rule type: narrow intent category
- Why overfit: should be handled by lexical/base score plus structure, not a special semantic branch
- Verdict: `replace`

7. `prefersOwnership`
- Rule type: abstract intent category
- Why overfit: the right idea, but the implementation is currently filename and architecture dependent
- Verdict: `replace`

8. `isToolingQuery`
- Rule type: LLM-agent/tool-specific intent category
- Why overfit: tightly coupled to Void tool architecture
- Verdict: `delete`

9. `isPromptQuery`
- Rule type: LLM/prompt-specific intent category
- Why overfit: only relevant to this product domain
- Verdict: `delete`

10. `isSemanticPromptQuery`
- Rule type: LLM/prompt-specific intent category
- Why overfit: only relevant to this product domain
- Verdict: `delete`

11. `penalizeUI`
- Rule type: broad domain heuristic
- Why overfit: over-penalizes UI files for non-UI questions based on wording rather than structure
- Verdict: `replace`

### File role labels

12. `wrapper`
- Rule type: role vocabulary
- Why overfit: depends on a specific architectural framing
- Verdict: `replace`

13. `core_execution`
- Rule type: role vocabulary
- Why overfit: not directly measurable without structural evidence
- Verdict: `replace`

14. `orchestrator`
- Rule type: role vocabulary
- Why overfit: architecture-specific abstraction
- Verdict: `replace`

15. `prompt_template`
- Rule type: Void/LLM-specific role vocabulary
- Why overfit: prompt-specific
- Verdict: `delete`

16. `prompt_assembly`
- Rule type: Void/LLM-specific role vocabulary
- Why overfit: prompt-specific
- Verdict: `delete`

17. `context_source`
- Rule type: Void-specific role vocabulary
- Why overfit: tied to this feature’s current architecture
- Verdict: `delete`

18. `definition_registry`
- Rule type: role vocabulary
- Why overfit: should be inferred by exports/imports instead
- Verdict: `replace`

19. `directory_engine`
- Rule type: Void-specific role vocabulary
- Why overfit: tied to one subsystem name
- Verdict: `delete`

20. `ui_surface`
- Rule type: role vocabulary
- Why overfit: architecture/stack dependent
- Verdict: `replace`

21. `generic`
- Rule type: fallback label
- Why overfit: only exists because of the custom role model
- Verdict: `delete`

### Void-specific filename rules

22. `directorystrservice.ts`
- Rule type: specific filename
- Location: role classification
- Verdict: `delete`

23. `contextgatheringservice.ts`
- Rule type: specific filename
- Location: role classification and path penalties
- Verdict: `delete`

24. `prompts.ts`
- Rule type: specific filename
- Location: role classification and path penalties
- Verdict: `delete`

25. `converttollmmessageservice.ts`
- Rule type: specific filename
- Location: role classification and path bonus
- Verdict: `delete`

26. `chatthreadservice.ts`
- Rule type: specific filename
- Location: role classification
- Verdict: `delete`

27. `toolsservice.ts`
- Rule type: specific filename
- Location: path bonus
- Verdict: `delete`

28. `channel.ts`
- Rule type: filename suffix with local meaning
- Location: wrapper classification
- Verdict: `replace`

29. `/common/contextgathering/contextgatherer.ts`
- Rule type: self-file special case
- Why keep: requested exception to avoid scorer self-ranking
- Verdict: `keep`

### Void-specific content probes

30. `computedirectorytree1deep`
- Verdict: `delete`

31. `renderchildrencombined`
- Verdict: `delete`

32. `getdirectorystrtool`
- Verdict: `delete`

33. `getsemanticsnippets(`
- Verdict: `delete`

34. `aitextsearch(`
- Verdict: `delete`

35. `gathercontext(`
- Verdict: `delete`

36. `const semanticinfo =`
- Verdict: `delete`

37. `const gatheredcontextinfo =`
- Verdict: `delete`

38. `<workspace_context>`
- Verdict: `delete`

39. `_generatechatmessagessystemmessage(`
- Verdict: `delete`

40. `chat_systemmessage({`
- Verdict: `delete`

41. `gatheredcontext = formatgatheredcontextforprompt`
- Verdict: `delete`

42. `fullsystemmessage = await this._generatechatmessagessystemmessage`
- Verdict: `delete`

43. `validateparams[toolname]`
- Verdict: `delete`

44. `calltool[toolname]`
- Verdict: `delete`

45. `_addmessagetothread(`
- Verdict: `delete`

46. `_setstreamstate(`
- Verdict: `delete`

47. `sendllmmessage`
- Rule type: Void-specific LLM dispatch probe
- Verdict: `delete`

48. `sendllmmessagetoproviderimplementation`
- Verdict: `delete`

49. `sendchat(`
- Verdict: `delete`

50. `sendfim(`
- Verdict: `delete`

51. `description:`
- Rule type: local proxy for definition objects
- Why overfit: too broad and architecture-dependent
- Verdict: `replace`

52. `params: {`
- Rule type: local proxy for definition objects
- Why overfit: too broad and architecture-dependent
- Verdict: `replace`

53. `preparellmchatmessages`
- Rule type: prompt/LLM-specific probe
- Verdict: `delete`

54. `task terms:`
- Rule type: self-formatting probe
- Verdict: `delete`

55. `getallurisindirectory`
- Verdict: `delete`

### Current penalties to keep

56. Penalty for test files (`/test/`, `.test.ts`)
- Why keep: requested explicitly; generally useful
- Verdict: `keep`

57. Penalty for the gatherer’s own file unless the query is about the gatherer
- Why keep: requested explicitly; prevents self-reference contamination
- Verdict: `keep`

## Replacement Direction

All deleted/replaced rules should be substituted by structural signals only:

1. high export count
2. high import fan-out
3. basename exact match
4. low dependency depth combined with high fan-out
5. recent modification if metadata is available

No Void-specific filenames or domain terms should remain in the judgment layer after refactor.
