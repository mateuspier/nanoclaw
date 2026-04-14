import { createTask } from '../db.js';
import { getPendingApproval, resolveApproval } from '../db.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';

export interface ApprovalDeps {
  channels: Channel[];
  findChannel: (channels: Channel[], jid: string) => Channel | undefined;
}

/**
 * Handle inline keyboard callback from Telegram approval buttons.
 * Data format: "approve:wf-abc123" | "reject:wf-abc123" | "adjust:wf-abc123"
 */
export async function handleApprovalCallback(
  senderId: string,
  data: string,
  ctx: any,
  deps: ApprovalDeps,
): Promise<void> {
  const colonIdx = data.indexOf(':');
  if (colonIdx === -1) return;

  const action = data.slice(0, colonIdx);
  const workflowId = data.slice(colonIdx + 1);

  if (!['approve', 'reject', 'adjust'].includes(action)) return;

  const approval = getPendingApproval(workflowId);
  if (!approval) {
    logger.warn({ workflowId, senderId }, 'Approval not found or already resolved');
    return;
  }

  switch (action) {
    case 'approve': {
      resolveApproval(workflowId, 'approved');
      // Schedule a one-shot task to merge and deploy
      const taskId = `task-deploy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createTask({
        id: taskId,
        group_folder: approval.group_folder,
        chat_jid: approval.chat_jid,
        prompt: `Merge branch "${approval.branch}" to main and deploy to production. Run: git checkout main && git merge ${approval.branch} && git push origin main && npx vercel --token  --yes --prod --scope miau-pop. Then delete the feature branch locally and remotely.`,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() + 5000).toISOString(),
        context_mode: 'isolated',
        next_run: new Date(Date.now() + 5000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      try {
        await ctx.editMessageCaption({ caption: `✅ *Aprovado!* Deploying \`${approval.branch}\`...`, parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn({ err }, 'Failed to edit approval message caption');
      }
      logger.info({ workflowId, branch: approval.branch, senderId }, 'Workflow approved');
      break;
    }

    case 'reject': {
      resolveApproval(workflowId, 'rejected');
      // Schedule cleanup task to delete the branch
      const taskId = `task-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createTask({
        id: taskId,
        group_folder: approval.group_folder,
        chat_jid: approval.chat_jid,
        prompt: `Delete branch "${approval.branch}" locally and remotely: git branch -D ${approval.branch} && git push origin --delete ${approval.branch}`,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() + 5000).toISOString(),
        context_mode: 'isolated',
        next_run: new Date(Date.now() + 5000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      try {
        await ctx.editMessageCaption({ caption: '❌ *Rejeitado.* Branch descartada.', parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn({ err }, 'Failed to edit rejection message caption');
      }
      logger.info({ workflowId, branch: approval.branch, senderId }, 'Workflow rejected');
      break;
    }

    case 'adjust': {
      resolveApproval(workflowId, 'adjusting');
      try {
        await ctx.editMessageCaption({ caption: '✏️ Envie o ajuste desejado como resposta...', parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn({ err }, 'Failed to edit adjust message caption');
      }
      logger.info({ workflowId, branch: approval.branch, senderId }, 'Workflow adjustment requested');
      // The next text message from this user in this chat will be picked up
      // by the router as a regular message and processed by the group's agent
      break;
    }
  }
}
