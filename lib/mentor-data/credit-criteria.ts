import type { BalanceDto } from '../contracts';
/** Published Canvas v548 BalanceDashboard source, lines 702–837; presentation rules, not automatic awards. */
export const CREDIT_CRITERIA: NonNullable<BalanceDto['creditCriteria']> = [
  {category:'Basic',label:'Finish one round of mentoring',points:20,cadence:'per round'},
  {category:'Basic',label:'Engage with mentees every day and always respond within 24 hours',points:10,cadence:'per round'},
  {category:'Basic',label:'Complete a meet-up',points:5,cadence:'per week'},
  {category:'Basic',label:'Extra groups (Senior Mentor level required)',points:15,cadence:'per extra group'},
  {category:'Bonus',label:'Excellent Meet-Up Organiser: over 10 mentees attending',points:5,cadence:'per week'},
  {category:'Bonus',label:'Creative Event Promoter: consistently promote events in a fun, creative or personal way',points:5,cadence:'staff assessed'},
  {category:'Bonus',label:'Volunteer at Orientation',points:5,cadence:'per contribution'},
  {category:'Bonus',label:'Best Collaborator: up to three mentors per round, judged by the Student Life Team',points:5,cadence:'per round'},
  ...[[3,20],[5,40],[8,50],[10,60],[15,70],[30,100]].map(([rounds,points])=>({category:'Milestone' as const,label:`Participate in ${rounds} rounds`,points,cadence:'on milestone'})),
  {category:'Award',label:'Outstanding Mentor Award, presented at the Gala Awards Night',points:30,cadence:'on award'},
];
