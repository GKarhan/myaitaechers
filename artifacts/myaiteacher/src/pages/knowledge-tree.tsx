import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetKnowledgeTree, getGetKnowledgeTreeQueryKey } from "@workspace/api-client-react";

type FilterTab = 'all' | 'mastered' | 'weak' | 'not_started';

export default function KnowledgeTree() {
  const { user, token, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { id } = useParams<{ id: string }>();
  const subjectId = parseInt(id || "", 10);
  
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');

  useEffect(() => {
    if (!authLoading && !token) {
      setLocation("/login");
    }
  }, [token, authLoading, setLocation]);

  const { data: treeData, isLoading: treeLoading } = useGetKnowledgeTree(subjectId, {
    query: {
      queryKey: getGetKnowledgeTreeQueryKey(subjectId),
      enabled: !!token && !isNaN(subjectId),
    }
  });

  if (authLoading || treeLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user || !treeData) return null;

  const filteredTopics = treeData.topics?.filter(topic => {
    if (activeFilter === 'all') return true;
    return topic.masteryLevel === activeFilter;
  }) || [];

  return (
    <div className="min-h-[100dvh] w-full bg-background text-white pb-20">
      <header className="border-b border-card-border bg-card/50 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link href={`/subjects/${subjectId}`} className="text-muted-foreground hover:text-white transition-colors">
            ← Հետ
          </Link>
          <div className="font-bold text-xl bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            {treeData.subjectName} — Գիտելիքի ծառ
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 pt-10">
        
        <div className="flex flex-wrap gap-2 mb-8 border-b border-card-border pb-6">
          <button 
            onClick={() => setActiveFilter('all')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border ${activeFilter === 'all' ? 'bg-white text-background border-white' : 'bg-card border-card-border text-muted-foreground hover:text-white'}`}
          >
            Բոլորը
          </button>
          <button 
            onClick={() => setActiveFilter('mastered')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border flex items-center gap-2 ${activeFilter === 'mastered' ? 'bg-secondary/20 text-secondary border-secondary/50' : 'bg-card border-card-border text-muted-foreground hover:text-white'}`}
          >
            <span className="w-2 h-2 rounded-full bg-secondary"></span>
            Յուրացված
          </button>
          <button 
            onClick={() => setActiveFilter('weak')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border flex items-center gap-2 ${activeFilter === 'weak' ? 'bg-accent/20 text-accent border-accent/50' : 'bg-card border-card-border text-muted-foreground hover:text-white'}`}
          >
            <span className="w-2 h-2 rounded-full bg-accent"></span>
            Թույլ
          </button>
          <button 
            onClick={() => setActiveFilter('not_started')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors border flex items-center gap-2 ${activeFilter === 'not_started' ? 'bg-destructive/20 text-destructive border-destructive/50' : 'bg-card border-card-border text-muted-foreground hover:text-white'}`}
          >
            <span className="w-2 h-2 rounded-full bg-destructive"></span>
            Չսկսված
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {filteredTopics.map((topic, idx) => {
            const isMastered = topic.masteryLevel === 'mastered';
            const isWeak = topic.masteryLevel === 'weak';
            const isNotStarted = topic.masteryLevel === 'not_started';
            
            let borderColorClass = '';
            let badgeText = '';
            let badgeColorClass = '';
            let dotColorClass = '';

            if (isMastered) {
              borderColorClass = 'border-l-secondary';
              badgeText = 'Յուրացված';
              badgeColorClass = 'bg-secondary/10 text-secondary border-secondary/20';
              dotColorClass = 'bg-secondary';
            } else if (isWeak) {
              borderColorClass = 'border-l-accent';
              badgeText = 'Թույլ';
              badgeColorClass = 'bg-accent/10 text-accent border-accent/20';
              dotColorClass = 'bg-accent';
            } else {
              borderColorClass = 'border-l-destructive';
              badgeText = 'Չսկսված';
              badgeColorClass = 'bg-destructive/10 text-destructive border-destructive/20';
              dotColorClass = 'bg-destructive';
            }

            return (
              <div key={idx} className={`p-6 rounded-2xl bg-card border border-card-border border-l-4 ${borderColorClass} flex flex-col h-full`}>
                <div className="flex justify-between items-start mb-4">
                  <h3 className="font-semibold text-lg leading-tight flex-1 pr-4">{topic.topicName}</h3>
                  <div className="font-bold text-xl">{topic.score}%</div>
                </div>
                
                <div className={`self-start px-2.5 py-1 rounded-md text-xs font-medium border flex items-center gap-1.5 mb-6 ${badgeColorClass}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColorClass}`}></span>
                  {badgeText}
                </div>
                
                <div className="mt-auto flex gap-3">
                  {isMastered && (
                    <button className="flex-1 py-2 bg-card border border-card-border hover:bg-secondary/10 hover:border-secondary/30 hover:text-secondary rounded-lg transition-colors text-sm font-medium">
                      Կրկնել
                    </button>
                  )}
                  {isWeak && (
                    <>
                      <button className="flex-1 py-2 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-lg transition-colors text-sm font-medium">
                        Սովորել
                      </button>
                      <button className="flex-1 py-2 bg-card border border-card-border hover:bg-accent/10 hover:border-accent/30 hover:text-accent rounded-lg transition-colors text-sm font-medium">
                        Կրկնել
                      </button>
                    </>
                  )}
                  {isNotStarted && (
                    <button className="flex-1 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg transition-colors text-sm font-medium shadow-lg shadow-primary/20">
                      Սովորել
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {treeData.recommendations && treeData.recommendations.length > 0 && (
          <div>
            <h2 className="text-2xl font-bold mb-6">AI-ի Առաջարկություններ</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {treeData.recommendations.map((rec, idx) => {
                let borderClass = '';
                let title = '';
                let bgClass = '';
                let dotClass = '';
                
                if (rec.type === 'start') {
                  borderClass = 'border-l-primary';
                  title = rec.topicName;
                  bgClass = 'bg-primary/5';
                  dotClass = 'bg-primary';
                } else if (rec.type === 'review') {
                  borderClass = 'border-l-accent';
                  title = rec.topicName;
                  bgClass = 'bg-accent/5';
                  dotClass = 'bg-accent';
                } else if (rec.type === 'repeat') {
                  borderClass = 'border-l-secondary';
                  title = rec.topicName;
                  bgClass = 'bg-secondary/5';
                  dotClass = 'bg-secondary';
                }
                
                return (
                  <div key={idx} className={`p-5 rounded-xl border border-card-border border-l-4 ${borderClass} ${bgClass}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full ${dotClass}`}></span>
                      <h4 className="font-semibold text-white">{title}</h4>
                    </div>
                    <p className="text-sm text-muted-foreground">{rec.message}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
