/**
 * Prompt templates for browser service sub-LLM operations.
 */

// ============================================================================
// DESCRIBE OPERATION
// ============================================================================

export const DESCRIBE_SYSTEM_PROMPT = `You are a web page analyzer. Your job is to describe web pages in a clear, actionable way.

RULES:
- Always include element IDs in square brackets like [42] when mentioning interactive elements
- Be concise - only mention what's needed to answer the question or complete the task
- Focus on actionable elements: buttons, links, input fields, navigation
- Use the user's language if you can detect it from the page content
- When a specific question is asked, answer it directly without unnecessary context`;

export function buildDescribePrompt(content: string, question?: string): string {
  if (question) {
    return `Here are the interactive elements on the page:

${content}

Question: ${question}

Answer the question directly and concisely. Include relevant element [IDs] so they can be interacted with. Don't describe unrelated parts of the page.`;
  }

  return `Here are the interactive elements on the page:

${content}

Task: Describe what's on this page. List key interactive elements with their [IDs].
Write a concise description (2-4 sentences) mentioning the most important elements.`;
}

export function buildDescribeContinuePrompt(content: string, question?: string): string {
  if (question) {
    return `Here are more elements from the same page:

${content}

Update your answer to "${question}" if you found additional relevant elements. Keep it concise and focused on the question. Include element [IDs].`;
  }

  return `Here are more elements from the same page:

${content}

Provide a COMPLETE updated description that incorporates your previous description AND any important new elements. Keep it concise (2-4 sentences).`;
}

// ============================================================================
// FIND_ALL OPERATION
// ============================================================================

export const FIND_ALL_SYSTEM_PROMPT = `You are extracting elements from a web page. Your job is to find ALL elements matching a query and return them as JSON.

RULES:
- Return ONLY a JSON array of matching elements
- Each element MUST have: {"id": number, "desc": "description with all requested details"}
- Include ALL details mentioned or implied in the query for each found element
- Find ALL matching elements, not just the first few
- If no matches found, return empty array []
- Do NOT include any explanation or text outside the JSON array`;

export function buildFindAllPrompt(content: string, query: string): string {
  return `Here are the interactive elements on the page:

${content}

Query: "${query}"

Find ALL elements matching this query. For each element, include ALL details requested or implied by the query.
Return a JSON array: [{"id": 42, "desc": "..."}, {"id": 43, "desc": "..."}, ...]

Return ONLY the JSON array, no other text.`;
}

export function buildFindAllContinuePrompt(content: string, query: string): string {
  return `Here are more elements from the same page:

${content}

Continue finding elements matching "${query}". Add any NEW matching elements to your previous list.
Include all requested details for each element.
Return the COMPLETE updated JSON array with ALL matches found so far.
Return ONLY the JSON array, no other text.`;
}

