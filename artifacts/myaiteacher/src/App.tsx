import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import NotFound from "@/pages/not-found";

import Home from "@/pages/index";
import Login from "@/pages/login";
import Register from "@/pages/register";
import Dashboard from "@/pages/dashboard";
import SubjectDetail from "@/pages/subject-detail";
import KnowledgeTree from "@/pages/knowledge-tree";
import LessonDetail from "@/pages/lesson-detail";
import LessonPage from "@/pages/lesson-page";
import Chat from "@/pages/chat";
import Books from "@/pages/books";
import Homework from "@/pages/homework";
import Progress from "@/pages/progress";
import SubjectProgress from "@/pages/subject-progress";
import AdminDashboard from "@/pages/admin-dashboard";
import ClassDetail from "@/pages/class-detail";
import TeacherDashboard from "@/pages/teacher-dashboard";
import QuizReview from "@/pages/quiz-review";
import QuizTake from "@/pages/quiz-take";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/classes/:id" component={ClassDetail} />
      <Route path="/teacher" component={TeacherDashboard} />
      <Route path="/subjects/:id" component={SubjectDetail} />
      <Route path="/knowledge-tree/:id" component={KnowledgeTree} />
      <Route path="/lessons/:id" component={LessonPage} />
      <Route path="/lesson/:id" component={LessonDetail} />
      <Route path="/chat/:id" component={Chat} />
      <Route path="/books" component={Books} />
      <Route path="/homework" component={Homework} />
      <Route path="/progress" component={Progress} />
      <Route path="/progress/subject/:id" component={SubjectProgress} />
      <Route path="/quiz/:id/review" component={QuizReview} />
      <Route path="/quiz/:id/take" component={QuizTake} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;