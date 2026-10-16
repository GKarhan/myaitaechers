import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { decideUnifiedResume, type UnifiedResumeState } from "./unified-mapping-resume-policy.js";
const baseline = (): UnifiedResumeState => ({
 activeC1:"none", activeTeaching:"none", hasCanonicalNodes:false,
 c1SourceVerified:false, c2MissingCount:0, teachingMissingCount:0, hasTeacherEdits:false,
});
describe("unified map resume safety",()=>{
 it("starts only when there is no canonical map",()=>assert.equal(decideUnifiedResume(baseline()).action,"START_C1"));
 it("waits on active jobs instead of double-submitting",()=>assert.equal(decideUnifiedResume({...baseline(),activeC1:"running"}).action,"WAIT"));
 it("waits on active teaching work",()=>assert.equal(decideUnifiedResume({...baseline(),activeTeaching:"pending"}).action,"WAIT"));
 it("does not overwrite partially mapped coverage failures",()=>assert.equal(decideUnifiedResume({...baseline(),activeC1:"coverage_failed",hasCanonicalNodes:true}).action,"REVIEW"));
 it("requires source verification for resume",()=>assert.equal(decideUnifiedResume({...baseline(),hasCanonicalNodes:true,c2MissingCount:2}).action,"REVIEW"));
 it("resumes missing C2 from verified canonical map",()=>assert.equal(decideUnifiedResume({...baseline(),hasCanonicalNodes:true,c1SourceVerified:true,c2MissingCount:1}).action,"START_C2"));
 it("resumes teaching after C2",()=>assert.equal(decideUnifiedResume({...baseline(),hasCanonicalNodes:true,c1SourceVerified:true,teachingMissingCount:2}).action,"START_TEACHING"));
 it("requires explicit review if teacher edits would be touched",()=>assert.equal(decideUnifiedResume({...baseline(),hasCanonicalNodes:true,c1SourceVerified:true,hasTeacherEdits:true,c2MissingCount:1}).action,"REVIEW"));
 it("checks quality instead of regenerating completed stages",()=>assert.equal(decideUnifiedResume({...baseline(),hasCanonicalNodes:true,c1SourceVerified:true}).action,"QUALITY_CHECK"));
});
