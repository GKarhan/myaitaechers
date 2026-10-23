const MONTHS = [
                            "հունվարի",
                            "փետրվարի",
                            "մարտի",
                            "ապրիլի",
                            "մայիսի",
                            "հունիսի",
                            "հուլիսի",
                            "օգոստոսի",
                            "սեպտեմբերի",
                            "հոկտեմբերի",
                            "նոյեմբերի",
                            "դեկտեմբերի",
                          ];
export function armenianDate(value:string|Date,year=true):string{
 const date=new Date(value);if(Number.isNaN(date.getTime()))return "";
 return `${date.getDate()} ${MONTHS[date.getMonth()]}${year?` ${date.getFullYear()} թ.`:""}`;
}
