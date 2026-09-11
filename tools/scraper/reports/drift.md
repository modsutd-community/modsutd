# drift

Written by `tools/scraper/mods_refresh.py`. Do not edit it by hand: the
next refresh overwrites the sections it ran, and deletes the file when
there is nothing left to say. It carries no timestamp on purpose, so a
month that finds the same drift as the last changes no file and opens no
pull request.

## minors

each minor against its own page. REPORTS ONLY - the requirements are prose, and the repo expands 'any HASS elective' into a real list

```
10 minors in the repo, gathered 2026-07-23

SUTD lists 12 minor pages; the repo carries 10.
  NOT IN THE REPO   Minor in Analytics
                    https://www.sutd.edu.sg/esd/education/undergraduate/minors/analytics
  NOT IN THE REPO   Minor in Engineering Systems (ES)
                    https://www.sutd.edu.sg/esd/education/undergraduate/minors/engineering-systems

  minor-aai      new codes            page names  21 codes  | page names, repo does not: 10.020
  minor-ai       new codes            page names  29 codes  | page names, repo does not: 10.020, 30.106, 50.006, 50.017, 50.020, 50.037, 50.043, 50.044, 50.057
                                    repo requires, page does not name: 02.143
  minor-cs       ok                   page names  22 codes
                                    repo requires, page does not name: 50.006, 50.007, 50.012, 50.016, 50.017, 50.020, 50.021, 50.033, 50.034, 50.035, 50.037, 50.038 (+27)
  minor-dai      new codes            page names  34 codes  | page names, repo does not: 10.020, 50.057
                                    repo requires, page does not name: 02.137, 02.140, 02.143, 02.147, 02.151, 02.159, 02.174, 02.201, 02.216, 02.228
  minor-dts      ok                   page names   3 codes
                                    repo requires, page does not name: 02.102, 02.140, 02.145, 02.147, 02.148, 02.151, 02.152, 02.153, 02.155, 02.159, 02.160, 02.164 (+17)
  minor-dh       new codes            page names   3 codes  | page names, repo does not: 02.139
                                    repo requires, page does not name: 02.102, 02.105, 02.108, 02.110, 02.120, 02.121, 02.124, 02.128, 02.135, 02.137, 02.143, 02.144 (+16)
  minor-hi       ok                   page names   8 codes
                                    repo requires, page does not name: 01.114, 02.230
  minor-hcd      new codes            page names  15 codes  | page names, repo does not: 02.532, 02.533, 02.534, 02.535, 30.123, 40.230, 50.006, 60.005
                                    repo requires, page does not name: 02.104, 02.145, 02.148, 02.164, 02.165, 02.166, 02.167, 02.173, 02.174, 02.180, 02.181, 02.182 (+5)
  minor-pbm      ok                   page names  13 codes
                                    repo requires, page does not name: 02.145, 02.148, 02.174, 02.182, 02.218, 02.230
  minor-sbd      ok                   page names  11 codes
                                    repo requires, page does not name: 02.104, 02.147, 02.153, 02.154, 02.155, 02.166, 02.167, 02.219, 02.222, 02.228, 02.231

7 thing(s) need a look, across 10 records and 12 published pages.
Read the page before editing data/minors.json. The requirements are prose, and a code appearing on a page is not always a requirement - it can be an example, or a prerequisite of one.
```

## prereqs

prerequisites against each mod's own page. Reports; `propose` is what acts on it

```
AGREES      116
NONE LISTED 148  (page says none, record says none)
NO PAGE     108: ['02.002', '02.101', '02.103', '02.104', '02.105', '02.106', '02.107', '02.108', '02.109', '02.110', '02.111', '02.112', '02.113', '02.114', '02.115', '02.116', '02.118', '02.119', '02.120', '02.121', '02.122', '02.123', '02.124', '02.125', '02.126', '02.127', '02.128', '02.129', '02.130', '02.131', '02.132', '02.133', '02.135', '02.136', '02.137', '02.139', '02.140', '02.142', '02.144', '02.145', '02.147', '02.148', '02.149', '02.150', '02.151', '02.152', '02.153', '02.154', '02.156', '02.157', '02.158', '02.159', '02.161', '02.162', '02.164', '02.165', '02.166', '02.167', '02.170', '02.171', '02.172', '02.173', '02.174', '02.175', '02.177', '02.178', '02.179', '02.180', '02.181', '02.182', '02.183', '02.201', '02.210', '02.212', '02.216', '02.219', '02.222', '02.223', '02.225', '02.228', '02.230', '02.231', '02.303', '02.XFER', '10.008', '10.009', '20.211', '30.316', '40.014', '50.034', '60.009', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999', '99.999']

RECORD ADDS WHAT THE PAGE OMITS (13) - the page prints a
Prerequisite heading with nothing under it, and the record names one:
  01.019   ['01.018']
  01.020   ['01.019']
  01.401   ['01.400']
  10.017   ['10.015']
  10.020   ['10.014']
  40.003   ['40.001', '40.002']
  40.007   ['40.001']
  40.008   ['40.004']
  40.009   ['40.001', '40.004']
  40.318   ['40.260']
  40.319   ['40.004']
  50.039   ['50.007']
  50.042   ['50.005']

DIFFERS (4) - read the sentence, do not apply blindly:

  10.022  Modelling Uncertainty  [or]
    page has, repo lacks : ['10.007']
    10.018 Modelling Space and Systems Workload: 5-0-7 *The first number represents the number of hours per week assigned for lectures, recitations and cohort classroom study. The second number represents

  20.224  Artificial & Architectural Intelligences in Design (HTC)  [and]
    page has, repo lacks : ['20.221', '20.222']
    None but preferably 20.221 Traditions: World history connections to vernacular architecture (HTC) 20.222 Modernism: Technology and Society in Architecture (HTC)

  40.001  Probability  [no joining word]
    repo has, page lacks : ['10.013']
    10.004 Advanced Math II Prerequisites (for Exchange Students): Multivariable Calculus

  50.037  Blockchain Technology  [and]
    page has, repo lacks : ['50.012', '50.020', '50.043']
    The course assumes a basic familiarity with computer programming and knowledge of the Python language. 50.004 Algorithms 50.005 Computer System Engineering 50.012 Networks , 50.020 Security , and 50.0

OR ON THE PAGE, NO TREE IN THE RECORD (17):
  03.007B  03.007A Innovating with Design and AI-1 (IDeA-1) Workload : 5-0-7 *The first number represents the number of hours per w
  10.022  10.018 Modelling Space and Systems Workload: 5-0-7 *The first number represents the number of hours per week assigned fo
  20.203  Students wishing to enrol in the course must have completed 20.201 Architecture Science and Technology 20.202 Architectu
  20.304  20.101 Architecture Core Studio 1 20.102 Architecture Core Studio 2 20.221 Traditions: World History Connections to Vern
  20.320  20.201 Architecture Science and Technology 20.202 Architectural Structure and Enclosure Design or speak with the profess
  20.321  20.201 Architecture Science and Technology 20.202 Architectural Structure and Enclosure Design Number of credits: 9 Work
  20.511  Bachelor of Science (Architecture and Sustainable Design) degree or equivalent Successful completion of Structured Inter
  20.512  Bachelor of Science (Architecture and Sustainable Design) degree or equivalent Successful completion of Structured Inter
  20.515  A student should be admitted to the M.Arch programme. This course is required for M.Arch accreditation Number of credits
  20.535  20.201 Architecture Science and Technology 20.202 Architectural Structure and Enclosure Design or speak with the profess
  40.316  10.022 Modelling Uncertainty (or equivalent) Number of credits: 12
  50.012  50.005 Computer System Engineering or A working knowledge of programming in Python and a strong foundation in computer s
  50.017  50.003 Elements of Software Construction or knowledge of the following. C/C++: All assignments are in C/C++ Calculus, Li
  50.041  50.004 Algorithms or consultation with the instructor
  50.046  50.005 Computer System Engineering (recommended) or a strong foundation in computer systems
  50.052  50.001 Information Systems & Programming or demonstrable experience and knowledge in object-oriented programming.
  50.053  50.003 Elements of Software Construction or good knowledge in JAVA programming or by consultation with the instructor.
```

## propose

reads the two reports with a model and edits data/courses where the page supports it. Every proposal is validated against the quoted page text before it is written

```
## proposed edits

4 course record(s) disagreed with their page. Read by GROQ.

### read and left alone

| course | why |
|---|---|
| 10.022 | Page text does not state any prerequisites for the course. |
| 20.224 | Page indicates no required prerequisites. |
| 40.001 | Page text does not list any prerequisites for the course. |
| 50.037 | Page states that 50.004 and 50.005 are helpful but not required, so they should not be prerequisites. |
```
