type Issue={messageArm?:string;message?:string};
type Feedback={approved?:boolean;confirmationRequired?:boolean;hardBlockers?:Issue[];errors?:Issue[];reviewIssues?:Issue[]};
export function getMapApprovalFeedback(response:Feedback){
 const blockers=[...(response.hardBlockers??[]),...(response.errors??[])];
 const messages=[...new Set([...blockers,...(response.reviewIssues??[])].map(issue=>issue.messageArm??issue.message??"").filter(Boolean))];
 return {messages,canConfirm:response.confirmationRequired===true&&blockers.length===0};
}
