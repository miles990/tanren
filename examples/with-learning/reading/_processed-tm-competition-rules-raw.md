# Teaching Monster Competition Rules (Raw from teaching.monster/rules)

Source: https://teaching.monster/rules
Fetched: 2026-03-29

---

## 1. Competition Mission

The contest seeks to identify "the AI Agent best capable of generating adaptive audiovisual educational materials based on learning needs." Three core competencies are evaluated: knowledge scaffolding using pedagogical theory, adaptive teaching adjusted to learner backgrounds, and maintaining cognitive engagement through effective narrative and multimodal presentation.

## 2. Background and Scope

**Core Task**: Teams develop a fully automated AI teaching system receiving learning needs via API and generating educational videos without human intervention.

**Subject Domains**: Secondary-level physics, biology, computer science, and mathematics, using "Advanced Placement (AP)" knowledge as reference standards, primarily in English.

**Format specifications**:
- Maximum 30 minutes duration
- Flexible styles: dynamic slides with voiceover, virtual instructors, or visual animations

## 3. Technical Specifications

**Submission Model**: Two-stage process requiring real-time API service during competition and Docker image submission for winning teams.

**Data Format**: JSON via HTTP/HTTPS with these required fields:

*Input*: request_id, course_requirement, student_persona
*Output*: video_url, subtitle_url (optional), supplementary_url (optional)

**Media Standards**:
- MP4 format, minimum 1280x720 resolution
- Audio: minimum 16 kHz sampling rate
- Video: maximum 3GB; supplementary materials: 100MB combined, 5 files maximum
- Download links valid 48 hours post-submission

**System Constraints**:
- 30-minute computation deadline per request
- Complete automation required; no human intervention permitted
- External tools and internet access allowed with transparency requirements
- Third-party materials must include source attribution, avoid fabricated data, and comply with copyright

## 4. Evaluation Criteria

Four dimensions apply to both warm-up and official rounds:

**Content Accuracy**: Zero hallucination principle; verified knowledge depth without superficial terminology; proper academic citations.

**Pedagogical Logic**: Scaffolding from simple to complex; natural narrative transitions; interconnected knowledge points forming logical chains.

**Learner Adaptation**: Identifying learner's zone of proximal development; adjusting language and analogies to audience experience level.

**Cognitive Engagement**: Integrating knowledge into vivid cases; employing teaching strategies maintaining attention; synchronized visual-auditory presentation.

## 5. Competition Phases

**Warm-up** (March 1-early April): Two rounds using AI Student evaluation for system testing and optimization; scores non-binding.

**Preliminary Round** (May 1-15): AI Student initial screening selects top 10; human judges conduct pairwise comparison arena determining top 3 finalists via Elo ratings.

**Finals** (June 12-13): Expert judges (teachers, principals, professors) pose challenging topics; finalists submit videos within 30-minute limits per topic; final winners determined by averaged rankings.

## 6. Awards

Certificate recipients include all finalists. Gold Medal: 1st place; Silver Medals: 2nd-3rd places.

## 7. Timeline (Anywhere on Earth timezone)

| Date | Phase | Activity |
|------|-------|----------|
| March 1 | Warm-up Round 1 | Topic release; AI Student evaluation begins |
| Early April | Warm-up Round 2 | Final pre-competition testing |
| May 1 | Preliminary starts | Topic release |
| May 15 | Preliminary deadline | AI screening; top 10 selected |
| June 8 | Finalist announcement | Results and top 3 names published |
| June 12 | Finals topic design | Judges release topics |
| June 13 | Finals submission | Videos submitted; review begins |
| June 26 | Awards workshop | Rankings announced; technical sharing |

## 8. Contact Information

**Organizer**: National Taiwan University AI Center of Research Excellence (NTU AI-CoRE)
**Email**: [email protected]
