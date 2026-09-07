"""Pydantic mirrors of the TS interfaces in frontend/src/types/index.ts.

Keep these in lock-step. Type drift between frontend and scraper is the
classic way the catalogue breaks silently.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Pillar = Literal["SMT", "EPD", "ESD", "CSD", "DAI", "ASD", "HASS"]
Term = Literal["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
LessonType = Literal[
    "Lecture", "Cohort", "Tutorial", "Lab", "Studio", "Seminar", "Recitation"
]
Day = Literal[
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
]


class Schedule(BaseModel):
    type: LessonType
    day: Day
    startTime: str
    endTime: str
    location: str
    instructors: list[str] = Field(default_factory=list)
    cohort: Optional[str] = None
    weeks: Optional[list[int]] = None


class GradingComponent(BaseModel):
    name: str
    percentage: int
    description: Optional[str] = None


class GradingScheme(BaseModel):
    components: list[GradingComponent]
    passingGrade: Optional[str] = None
    # 'official' when parsed from the course page's Learning assessment
    # table. Only official grading ships.
    source: Optional[str] = None


class Workload(BaseModel):
    lecture: int
    tutorial: int
    project: int
    preparation: int
    total: int
    # 'official' when read off the course page's "Workload: a-b-c" line;
    # absent means a hand-estimated placeholder.
    source: Optional[str] = None


class Mod(BaseModel):
    code: str
    name: str
    description: str
    credits: int
    department: str
    pillar: Pillar
    term: Term
    prerequisites: list[str] = Field(default_factory=list)
    corequisites: list[str] = Field(default_factory=list)
    schedules: list[Schedule] = Field(default_factory=list)
    grading: Optional[GradingScheme] = None
    workload: Optional[Workload] = None
    # Official listing tags from sutd.edu.sg ("Term 5", "AI Track", ...).
    tags: list[str] = Field(default_factory=list)


class Venue(BaseModel):
    code: str
    name: str
    building: str
    floor: int
    type: Literal[
        "Lecture Theatre", "Cohort Classroom", "Think Tank",
        "Lab", "Seminar Room", "Meeting Room", "Studio", "Auditorium",
        "Facility",
    ]
    capacity: Optional[int] = None
    facilities: Optional[list[str]] = None
    directions: Optional[str] = None
    landmarks: Optional[list[str]] = None
    altNames: Optional[list[str]] = None
    panoScenes: Optional[list[dict]] = None
    facility: Optional[bool] = None
