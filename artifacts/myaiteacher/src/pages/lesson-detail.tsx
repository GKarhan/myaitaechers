import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import StudentLayout from "@/components/StudentLayout";
import LearningScopeDialog from "@/components/LearningScopeDialog";
export default function LessonDetail(){
  const {id}=useParams<{id:string}>();const lessonId=Number(id);const {token}=useAuth();const [open,setOpen]=useState(false);
  const {data,isLoading,error}=useQuery({queryKey:["student-lesson-outline",lessonId,token],enabled:!!token&&lessonId>0,
    queryFn:()=>customFetch<{lesson:{title:string};nodes:Array<{id:number;title:string;learningObjective:string|null}>}>(`/api/lessons/${lessonId}/student-package`,{headers:{Authorization:`Bearer ${token}`}})});
  return <StudentLayout><Link href="/dashboard?section=tasks" className="text-secondary">← Իմ դասերը</Link>
    {isLoading?<p className="py-8">Բեռնվում է…</p>:error?<p className="py-8 text-red-400">Դասի տվյալները չհաջողվեց բեռնել։</p>:data&&<div className="max-w-3xl py-6 space-y-6">
      <h1 className="text-2xl font-bold">{data.lesson.title}</h1><h2 className="text-xl font-semibold">Դասի պլան</h2>
      <ol className="space-y-3">{data.nodes.map((node,i)=><li key={node.id} className="p-4 rounded-xl bg-card border border-white/10"><p className="font-semibold">{i+1}. {node.title}</p>{node.learningObjective&&<p className="mt-2 text-sm text-muted-foreground">{node.learningObjective}</p>}</li>)}</ol>
      <button className="px-5 py-3 rounded-xl bg-primary font-semibold" onClick={()=>setOpen(true)}>Սովորել</button>
      {open&&<LearningScopeDialog lessonId={lessonId} title={data.lesson.title} onClose={()=>setOpen(false)}/>}
    </div>}
  </StudentLayout>;
}
