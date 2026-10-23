import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch, getGetChatHistoryQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
export default function LearningScopeDialog({lessonId,title,onClose}:{lessonId:number;title:string;onClose:()=>void}) {
  const {token}=useAuth(); const [,navigate]=useLocation();const queryClient=useQueryClient();
  const [nodes,setNodes]=useState<Array<{id:number;title:string}>>([]);
  const [mode,setMode]=useState<"LESSON"|"NODES">("LESSON");
  const [selected,setSelected]=useState<number[]>([]);
  const [loading,setLoading]=useState(true); const [pending,setPending]=useState(false);const [error,setError]=useState("");
  useEffect(()=>{let cancelled=false;
    customFetch<{nodes:Array<{id:number;title:string}>}>(`/api/lessons/${lessonId}/student-package`,{headers:{Authorization:`Bearer ${token}`}})
      .then(data=>{if(!cancelled)setNodes(data.nodes);})
      .catch(()=>{if(!cancelled)setError("Դասի տվյալները չհաջողվեց բեռնել։");})
      .finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[lessonId,token]);
  useEffect(()=>{const listener=(e:KeyboardEvent)=>{if(e.key==="Escape"&&!pending)onClose();};window.addEventListener("keydown",listener);return()=>window.removeEventListener("keydown",listener);},[onClose,pending]);
  async function start(){if(pending)return;setPending(true);setError("");try{
    await customFetch(`/api/lessons/${lessonId}/start-fresh`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({nodeIds:mode==="LESSON"?null:selected})});
    await customFetch("/api/chat",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({lessonId,message:"Սկսենք"})});
    queryClient.removeQueries({queryKey:getGetChatHistoryQueryKey({lessonId})});
    queryClient.removeQueries({queryKey:["teacher-session-state",lessonId]});
    navigate(`/chat/${lessonId}`);
  }catch(e){const data=(e as {data?:{message?:string}}).data;setError(data?.message??"Ուսուցումը չհաջողվեց սկսել։ Փորձիր կրկին։");setPending(false);}}
  return <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onClick={e=>{if(e.target===e.currentTarget&&!pending)onClose();}}>
    <section role="dialog" aria-modal="true" aria-labelledby="scope-title" className="w-full max-w-xl rounded-2xl bg-card border border-white/15 p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
      <h2 id="scope-title" className="text-xl font-bold">Ի՞նչ ես ուզում սովորել</h2><p className="text-sm text-muted-foreground mt-2 mb-5">{title}</p>
      <label className="flex gap-3 rounded-xl border border-white/10 p-4 mb-3"><input autoFocus type="radio" name="learning-scope" checked={mode==="LESSON"} onChange={()=>setMode("LESSON")} disabled={pending}/>Ամբողջ դասը</label>
      <label className="flex gap-3 rounded-xl border border-white/10 p-4"><input type="radio" name="learning-scope" checked={mode==="NODES"} onChange={()=>setMode("NODES")} disabled={pending}/>Ընտրել մեկ կամ մի քանի գիտելիքի հանգույց</label>
      {loading?<p className="py-4">Բեռնվում է…</p>:mode==="NODES"&&<div className="space-y-2 mt-4">{nodes.map(node=><label key={node.id} className="flex gap-3 p-3 rounded-lg bg-background/50"><input type="checkbox" checked={selected.includes(node.id)} disabled={pending} onChange={e=>setSelected(old=>e.target.checked?[...old,node.id]:old.filter(id=>id!==node.id))}/>{node.title}</label>)}<p className="text-sm text-muted-foreground">Ընտրված է՝ {selected.length}</p></div>}
      {error&&<p role="alert" className="text-red-400 my-3">{error}</p>}
      <div className="flex gap-3 mt-6"><button disabled={loading||pending||!nodes.length||(mode==="NODES"&&!selected.length)} onClick={start} className="rounded-xl bg-primary px-5 py-3 font-semibold disabled:opacity-40">{pending?"Սկսվում է…":"Սկսել ուսուցումը"}</button><button disabled={pending} onClick={onClose} className="rounded-xl border border-white/15 px-5 py-3">Փակել</button></div>
    </section>
  </div>;
}
